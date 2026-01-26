#!/usr/bin/env python3
"""
PurpleAir UK Sensor Data Fetcher

This script fetches all PurpleAir sensors within the UK bounding box
and stores them in the Supabase database.

Usage:
    python3 scripts/purpleair/purpleair_get_uk_sensors.py [--fetch-sensors] [--fetch-data] [--daily]

Options:
    --fetch-sensors    Initial discovery of all UK sensors
    --fetch-data      Fetch current data for all sensors
    --daily           Run daily data update
"""

import os
import sys
import requests
import json
import time
import logging
from datetime import datetime, timezone
from typing import List, Dict, Optional
import argparse
from dotenv import load_dotenv
from supabase import create_client, Client

# Load environment variables from .env file (for local development)
load_dotenv()

# Configuration
API_KEY_FILE = '/Users/mikehinford/Library/CloudStorage/Dropbox/Projects/CIC Website/CIC Air Quality Networks/Resources/PurpleAir/Purpleair-Read-APIkey.txt'
API_BASE_URL = 'https://api.purpleair.com/v1'

# UK Bounding Box (covers entire UK including islands)
UK_BBOX = {
    'nwlat': 61.0,   # North (Shetland Islands)
    'nwlng': -11.0,  # West (western Ireland)
    'selat': 49.0,   # South (Channel Islands)
    'selng': 2.0     # East (eastern England)
}

# Supabase configuration from environment variables
supabase_url = os.getenv('SUPABASE_URL')
supabase_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY')

# Initialize Supabase client
supabase: Client = create_client(supabase_url, supabase_key)

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('purpleair_fetch.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class PurpleAirFetcher:
    def __init__(self):
        self.api_key = self._load_api_key()
        self.session = requests.Session()
        self.session.headers.update({'X-API-Key': self.api_key})
        
    def _load_api_key(self) -> str:
        """Load API key from file"""
        try:
            with open(API_KEY_FILE, 'r') as f:
                return f.read().strip()
        except FileNotFoundError:
            logger.error(f"API key file not found: {API_KEY_FILE}")
            sys.exit(1)
        except Exception as e:
            logger.error(f"Error reading API key: {e}")
            sys.exit(1)
    
    def _make_api_call(self, endpoint: str, params: Dict = None) -> Optional[Dict]:
        """Make API call with error handling and point tracking"""
        url = f"{API_BASE_URL}/{endpoint}"
        
        try:
            start_time = time.time()
            response = self.session.get(url, params=params)
            response.raise_for_status()
            
            # Extract point usage from headers
            points_used = int(response.headers.get('X-Point-Usage', 0))
            response_size = len(response.content)
            
            # Log API usage
            self._log_api_usage(endpoint, params, points_used, response_size, response.json())
            
            logger.info(f"API call successful: {points_used} points used, {response_size} bytes")
            logger.info(f"API response headers: {dict(response.headers)}")
            return response.json()
            
        except requests.exceptions.RequestException as e:
            logger.error(f"API call failed: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error: {e}")
            return None
    
    def _log_api_usage(self, endpoint: str, params: Dict, points_used: int, 
                      response_size: int, response_data: Dict):
        """Log API usage to database"""
        try:
            supabase.table('purpleair_api_usage').insert({
                'api_call_type': endpoint,
                'sensors_queried': len(response_data.get('data', [])) if 'data' in response_data else 0,
                'points_used': points_used,
                'response_size_bytes': response_size,
                'api_response': response_data
            }).execute()
            
        except Exception as e:
            logger.error(f"Failed to log API usage: {e}")
    
    def fetch_uk_sensors(self) -> List[Dict]:
        """Fetch all sensors within UK bounding box"""
        logger.info("Fetching UK sensors using bounding box...")
        
        params = {
            'nwlat': UK_BBOX['nwlat'],
            'nwlng': UK_BBOX['nwlng'], 
            'selat': UK_BBOX['selat'],
            'selng': UK_BBOX['selng'],
            'fields': 'sensor_index,name,location_type,latitude,longitude,altitude,hardware,firmware_version,last_seen,date_created',
            'max_age': 0  # Include all sensors ever reported
        }
        
        response = self._make_api_call('sensors', params)
        
        if response and 'data' in response:
            sensors = response['data']
            logger.info(f"Found {len(sensors)} sensors in UK bounding box")
            return sensors
        else:
            logger.error("No sensor data received")
            return []
    
    def store_sensors(self, sensors: List[Dict]):
        """Store sensor metadata in database"""
        if not sensors:
            return
            
        logger.info(f"Storing {len(sensors)} sensors in database...")
        
        try:
            # Process sensors in batches to avoid timeouts
            batch_size = 100
            stored_count = 0
            
            for i in range(0, len(sensors), batch_size):
                batch = sensors[i:i + batch_size]
                
                # Prepare sensor data for upsert
                sensor_records = []
                for sensor in batch:
                    # Map API fields to database columns
                    sensor_data = {
                        'sensor_index': sensor[0],
                        'name': sensor[1] if len(sensor) > 1 else None,
                        'location_type': sensor[2] if len(sensor) > 2 else None,
                        'latitude': sensor[3] if len(sensor) > 3 else None,
                        'longitude': sensor[4] if len(sensor) > 4 else None,
                        'altitude': sensor[5] if len(sensor) > 5 else None,
                        'hardware': sensor[6] if len(sensor) > 6 else None,
                        'firmware_version': sensor[7] if len(sensor) > 7 else None,
                        'last_seen': datetime.fromtimestamp(int(sensor[8]) / 1000).isoformat() if len(sensor) > 8 and sensor[8] else None,
                        'date_created': datetime.fromtimestamp(int(sensor[9]) / 1000).isoformat() if len(sensor) > 9 and sensor[9] else None
                    }
                    sensor_records.append(sensor_data)
                
                # Upsert batch
                supabase.table('purpleair_sensors').upsert(sensor_records).execute()
                stored_count += len(batch)
                logger.info(f"Stored {stored_count}/{len(sensors)} sensors")
                
                # Small delay between batches
                if i + batch_size < len(sensors):
                    time.sleep(0.1)
            
            logger.info(f"Successfully stored {len(sensors)} sensors")
            
        except Exception as e:
            logger.error(f"Failed to store sensors: {e}")
    
    def fetch_sensor_data(self, sensor_indices: List[int]) -> List[Dict]:
        """Fetch current data for specific sensors"""
        logger.info(f"Fetching data for {len(sensor_indices)} sensors...")
        
        # PurpleAir API allows max 1000 sensors per request
        max_sensors_per_request = 1000
        all_data = []
        
        for i in range(0, len(sensor_indices), max_sensors_per_request):
            batch = sensor_indices[i:i + max_sensors_per_request]
            
            params = {
                'fields': 'sensor_index,pm2.5,pm2.5_atm,pm10.0,pm10.0_atm,temperature,humidity,pressure',
                'show': ','.join(map(str, batch))
            }
            
            response = self._make_api_call('sensors', params)
            
            if response and 'data' in response:
                all_data.extend(response['data'])
                
                # Rate limiting - wait between requests
                if i + max_sensors_per_request < len(sensor_indices):
                    time.sleep(1)  # 1 second delay between batches
            else:
                logger.error(f"Failed to fetch data for batch {i//max_sensors_per_request + 1}")
        
        logger.info(f"Fetched data for {len(all_data)} sensors")
        return all_data
    
    def store_observations(self, sensor_data: List[Dict]):
        """Store sensor observations in database"""
        if not sensor_data:
            return
            
        logger.info(f"Storing {len(sensor_data)} observations...")
        
        try:
            # Process observations in batches
            batch_size = 100
            current_time = datetime.now(timezone.utc)
            stored_count = 0
            
            for i in range(0, len(sensor_data), batch_size):
                batch = sensor_data[i:i + batch_size]
                
                # Prepare observation data
                observation_records = []
                for data in batch:
                    obs_data = {
                        'sensor_index': data[0],
                        'observed_at': current_time.isoformat(),
                        'pm2_5_a': data[1] if len(data) > 1 else None,
                        'pm2_5_b': None,  # not returned in this endpoint
                        'pm2_5_atm_a': data[2] if len(data) > 2 else None,
                        'pm2_5_atm_b': None,
                        'pm10_0_a': data[3] if len(data) > 3 else None,
                        'pm10_0_b': None,
                        'pm10_0_atm_a': data[4] if len(data) > 4 else None,
                        'pm10_0_atm_b': None,
                        'temperature': data[5] if len(data) > 5 else None,
                        'humidity': data[6] if len(data) > 6 else None,
                        'pressure': data[7] if len(data) > 7 else None
                    }
                    observation_records.append(obs_data)
                
                # Insert batch
                supabase.table('purpleair_observations').insert(observation_records).execute()
                stored_count += len(batch)
                logger.info(f"Stored {stored_count}/{len(sensor_data)} observations")
                
                # Small delay between batches
                if i + batch_size < len(sensor_data):
                    time.sleep(0.1)
            
            logger.info(f"Successfully stored {len(sensor_data)} observations")
            
        except Exception as e:
            logger.error(f"Failed to store observations: {e}")
    
    def get_stored_sensor_indices(self) -> List[int]:
        """Get sensor indices from database"""
        try:
            response = supabase.table('purpleair_sensors').select('sensor_index').eq('location_type', 0).execute()
            
            if response.data:
                return [sensor['sensor_index'] for sensor in response.data]
            else:
                return []
            
        except Exception as e:
            logger.error(f"Failed to get sensor indices: {e}")
            return []

def main():
    parser = argparse.ArgumentParser(description='PurpleAir UK Sensor Data Fetcher')
    parser.add_argument('--fetch-sensors', action='store_true', help='Initial discovery of UK sensors')
    parser.add_argument('--fetch-data', action='store_true', help='Fetch current data for sensors')
    parser.add_argument('--daily', action='store_true', help='Run daily update')
    parser.add_argument('--dry-run', action='store_true', help='Test mode - use sample data instead of API calls')
    
    args = parser.parse_args()
    
    if not any([args.fetch_sensors, args.fetch_data, args.daily, args.dry_run]):
        parser.print_help()
        return
    
    fetcher = PurpleAirFetcher()
    
    try:
        if args.dry_run:
            logger.info("DRY RUN MODE - Using sample data instead of API calls")
            
            # Sample sensor data (based on typical PurpleAir API response)
            sample_sensors = [
                [12345, "Test Sensor London", 0, 51.5074, -0.1278, 25, "PMS5003", "1.2.3", 1702396800000, 1702396800000],
                [12346, "Test Sensor Manchester", 0, 53.4808, -2.2426, 35, "PMS5003", "1.2.3", 1702396800000, 1702396800000],
                [12347, "Test Sensor Edinburgh", 0, 55.9533, -3.1883, 45, "PMS5003", "1.2.3", 1702396800000, 1702396800000],
                [12348, "Test Sensor Cardiff", 0, 51.4816, -3.1791, 30, "PMS5003", "1.2.3", 1702396800000, 1702396800000],
                [12349, "Test Sensor Belfast", 0, 54.5973, -5.9301, 20, "PMS5003", "1.2.3", 1702396800000, 1702396800000]
            ]
            
            # Sample observation data
            sample_observations = [
                [12345, 12.5, 10.2, 15.8, 13.1, 18.2, 16.5, 20.1, 22.3, 65.4, 1013.2],
                [12346, 18.3, 15.7, 22.1, 19.4, 25.6, 23.8, 28.9, 31.2, 58.7, 1015.8],
                [12347, 8.9, 7.2, 11.3, 9.6, 14.7, 13.1, 17.8, 19.2, 72.3, 1011.5],
                [12348, 22.1, 19.8, 26.4, 23.7, 31.2, 28.9, 35.6, 38.1, 61.9, 1014.7],
                [12349, 15.6, 13.4, 18.9, 16.2, 21.7, 19.8, 24.3, 26.8, 68.2, 1012.9]
            ]
            
            # Store sample sensors
            fetcher.store_sensors(sample_sensors)
            logger.info(f"Dry run: Stored {len(sample_sensors)} sample sensors")
            
            # Store sample observations
            fetcher.store_observations(sample_observations)
            logger.info(f"Dry run: Stored {len(sample_observations)} sample observations")
            
            logger.info("Dry run completed successfully - no API calls made")
            return
        
        if args.fetch_sensors:
            logger.info("Starting sensor discovery...")
            sensors = fetcher.fetch_uk_sensors()
            if sensors:
                fetcher.store_sensors(sensors)
                logger.info(f"Sensor discovery complete: {len(sensors)} sensors found")
        
        if args.fetch_data or args.daily:
            logger.info("Fetching sensor data...")
            sensor_indices = fetcher.get_stored_sensor_indices()
            
            if sensor_indices:
                sensor_data = fetcher.fetch_sensor_data(sensor_indices)
                if sensor_data:
                    fetcher.store_observations(sensor_data)
                    logger.info(f"Data fetch complete: {len(sensor_data)} observations stored")
            else:
                logger.warning("No sensors found in database. Run --fetch-sensors first.")
        
        logger.info("Script completed successfully")
        
    except KeyboardInterrupt:
        logger.info("Script interrupted by user")
    except Exception as e:
        logger.error(f"Script failed: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()