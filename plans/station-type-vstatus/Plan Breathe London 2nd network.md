Yes, I think you are remembering something real, but the naming is a bit confusing.

There appear to be two related Breathe London things:

1. Breathe London, the current GLA/partner network on breathelondon.org
2. Breathe London Communities, on breathelondon-communities.org

The current Breathe London site explicitly links out to “Breathe London Communities” as a separate Breathe London project.  

The one you are probably using now

From the current Breathe London API docs, the active API looks like the newer managed network. The /ListSensors example includes SensorContract: "Vodafone" and the /SensorData example also includes SensorContract: "Vodafone" plus a RatificationStatus field.  

The current Breathe London site says the network uses Airly sensors, sends data via the Vodafone network to CERC, and CERC applies automated QA/QC and calibration before the data appears on the website.   It also says CERC provides calibrated hourly data by API, Scotswolds handles deployment/PAS4023 compliance, and Ricardo applies annual checks and QA/QC challenge.  

So I’d treat that as:

Source type: Community
Verification Status: Not verified, if RatificationStatus = P
Note: Calibrated managed sensor network

Not “Official”, because it is still small-sensor data rather than AURN/reference-grade regulatory monitoring. But it is definitely not the same as a random Sensor.Community box either.

The older/community one

Breathe London Communities looks more explicitly community-programme based. Its site talks about “Community Programme Groups” and “Breathe London Communities Nodes”, with groups using nodes to advocate for healthier communities.  

So I’d treat that as:

Source type: Community
Verification Status: N/A, unless the data feed has a specific verification or ratification field
Note: Community node network

Important bit: Breathe London API has RatificationStatus

This changes things slightly. The Breathe London API example response includes:

"RatificationStatus": "P"

That strongly suggests your importer should preserve that field.  

For UK AQ, I’d map it like this:

Breathe London field	UK AQ label
RatificationStatus = P	Verification Status: Not verified
final/ratified value, if they publish one	Verification Status: Verified
missing/unknown status	Verification Status: N/A or Not verified, depending on source docs

For Breathe London specifically, because they expose a ratification status, I’d lean to:

Missing or unknown = Not verified

That is safer than implying final status.

Should both Breathe London feeds be merged?

For the public UI, yes, I’d probably show them under one network name:

Breathe London

But internally, keep them separate.

Something like:

* network_name: Breathe London
* network_family: breathe_london
* source_feed: breathe_london_api_v2 or breathe_london_communities
* sensor_contract: Vodafone, Airly, old node type, etc
* source_type: community
* verification_status: verified / not_verified / n/a
* qa_note: calibrated_managed_network / community_node / unknown

That lets the public see one clean network, while your data model still knows what each record actually came from.

My recommendation for your labels

For now:

Current Breathe London API

Source type: Community
Verification Status: Not verified
Extra note: Calibrated managed sensor network

Breathe London Communities later

Source type: Community
Verification Status: N/A
Extra note: Community node network

Unless the Communities data source also has a ratification/verification field. Then map that field directly.

I would not add Managed as a public source type. Your simple split still works:

Official means official/reference/regulatory monitoring.
Community means non-regulatory sensor data, including managed low-cost networks.

Then the extra nuance is handled by Verification Status and a quiet note, not by adding more public categories.