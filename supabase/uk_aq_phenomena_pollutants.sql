-- Enrich phenomena with emissions inventory pollutant metadata.

alter table if exists phenomena
  drop column if exists emission_unit,
  drop column if exists short_pollutant,
  add column if not exists pollutant_label text;

with ref(pollutant, emission_unit, short_pollutant) as (
  values
    ('Black Carbon', 'kilotonne', 'BC'),
    ('PM0.1', 'kilotonne', 'PM0-1'),
    ('PM1', 'kilotonne', 'PM1'),
    ('PM10', 'kilotonne', 'PM10'),
    ('PM2.5', 'kilotonne', 'PM2-5'),
    ('TPM', 'kilotonne', 'TPM'),
    ('Acenaphthene', 'kg', 'ACE'),
    ('Acenaphthylene', 'kg', 'ACY'),
    ('Anthracene', 'kg', 'ANT'),
    ('Benz[a]anthracene', 'kg', 'BaA'),
    ('Benzo[a]pyrene', 'kg', 'BaP'),
    ('Benzo[b]fluoranthene', 'kg', 'BbF'),
    ('Benzo[ghi]perylene', 'kg', 'BghiP'),
    ('Benzo[k]fluoranthene', 'kg', 'BkF'),
    ('Chrysene', 'kg', 'CHR'),
    ('Decabromodiphenyl ether', 'kg', 'BDE-209'),
    ('Dibenz[ah]anthracene', 'kg', 'DahA'),
    ('Dioxins (PCDD/F)', 'grams International Toxic Equivalent', 'PCDDF'),
    ('Fluoranthene', 'kg', 'FLA'),
    ('Fluorene', 'kg', 'FLU'),
    ('Hexachlorobenzene', 'kg', 'HCB'),
    ('Indeno[123-cd]pyrene', 'kg', 'IcdP'),
    ('Lindane', 't', 'γ-HCH'),
    ('Naphthalene', 'kg', 'NAP'),
    ('Octabromodiphenyl ether', 'kg', 'BDE-183'),
    ('Pentabromodiphenyl Ether', 'kg', 'BDE-99'),
    ('Pentachlorophenol', 't', 'PCP'),
    ('Phenanthrene', 'kg', 'PHE'),
    ('Polychlorinated biphenyls', 'kg', 'PCBs'),
    ('Pyrene', 'kg', 'PYR'),
    ('Short Chain Chlorinated Paraffins (C10-13)', 'kg', 'SCCPs'),
    ('Arsenic', 'kilotonne', 'As'),
    ('Beryllium', 'kilotonne', 'Be'),
    ('Cadmium', 'kilotonne', 'Cd'),
    ('Calcium', 't', 'Ca'),
    ('Chromium', 'kilotonne', 'Cr'),
    ('Copper', 'kilotonne', 'Cu'),
    ('Lead', 'kilotonne', 'Pb'),
    ('Magnesium', 't', 'Mg'),
    ('Manganese', 'kilotonne', 'Mn'),
    ('Mercury', 'kilotonne', 'Hg'),
    ('Nickel', 'kilotonne', 'Ni'),
    ('Potassium', 't', 'K'),
    ('Selenium', 'kilotonne', 'Se'),
    ('Sodium', 't', 'Na'),
    ('Tin', 'kilotonne', 'Sn'),
    ('Vanadium', 'kilotonne', 'V'),
    ('Zinc', 'kilotonne', 'Zn'),
    ('13-butadiene', 'kilotonne', '13-BD'),
    ('Ammonia', 'kilotonne', 'NH3'),
    ('Benzene', 'kilotonne', 'C6H6'),
    ('Black Smoke', 'kilotonne', 'BS'),
    ('Carbon Monoxide', 'kilotonne', 'CO'),
    ('Hydrogen Chloride', 'kilotonne', 'HCl'),
    ('Hydrogen Fluoride', 'kilotonne', 'HF'),
    ('Methane', 'kilotonne', 'CH4'),
    ('Nitrogen Oxides as NO2', 'kilotonne', 'NOx'),
    ('Non Methane VOC', 'kilotonne', 'NMVOC'),
    ('Sulphur Dioxide', 'kilotonne', 'SO2'),
    ('16PAH', 'kg', '16PAH'),
    ('Activity Data', 'TJ (net)', 'ActData'),
    ('Carbon Dioxide as Carbon', 'kilotonne', 'CO2-C'),
    ('HFCs', 'kt CO2 equivalent', 'HFCs'),
    ('NF3', 'kt CO2 equivalent', 'NF3'),
    ('Nitrous Oxide', 'kilotonne', 'N2O'),
    ('PFCs', 'kt CO2 equivalent', 'PFCs'),
    ('Sulphur hexafluoride', 'kt CO2 equivalent', 'SF6'),
    ('Total GHGs in CO2 Eq.', 'kilotonne', 'GHG-CO2-eq')
)
update phenomena
set pollutant_label = coalesce(phenomena.pollutant_label, ref.pollutant)
from ref
where lower(phenomena.label) = lower(ref.pollutant)
   or lower(phenomena.notation) = lower(ref.short_pollutant)
   or lower(phenomena.notation) = lower(ref.pollutant);

-- Fallback: use the Eionet label without bracketed qualifiers (e.g., "(air)").
update phenomena
set pollutant_label = nullif(
  trim(regexp_replace(label, '\s*\([^)]*\)', '', 'g')),
  ''
)
where pollutant_label is null
  and eionet_uri is not null
  and label is not null;

-- Pollutants present in monitoring data but not in the reference list.
with ref(pollutant, emission_unit, short_pollutant) as (
  values
    ('Black Carbon', 'kilotonne', 'BC'),
    ('PM0.1', 'kilotonne', 'PM0-1'),
    ('PM1', 'kilotonne', 'PM1'),
    ('PM10', 'kilotonne', 'PM10'),
    ('PM2.5', 'kilotonne', 'PM2-5'),
    ('TPM', 'kilotonne', 'TPM'),
    ('Acenaphthene', 'kg', 'ACE'),
    ('Acenaphthylene', 'kg', 'ACY'),
    ('Anthracene', 'kg', 'ANT'),
    ('Benz[a]anthracene', 'kg', 'BaA'),
    ('Benzo[a]pyrene', 'kg', 'BaP'),
    ('Benzo[b]fluoranthene', 'kg', 'BbF'),
    ('Benzo[ghi]perylene', 'kg', 'BghiP'),
    ('Benzo[k]fluoranthene', 'kg', 'BkF'),
    ('Chrysene', 'kg', 'CHR'),
    ('Decabromodiphenyl ether', 'kg', 'BDE-209'),
    ('Dibenz[ah]anthracene', 'kg', 'DahA'),
    ('Dioxins (PCDD/F)', 'grams International Toxic Equivalent', 'PCDDF'),
    ('Fluoranthene', 'kg', 'FLA'),
    ('Fluorene', 'kg', 'FLU'),
    ('Hexachlorobenzene', 'kg', 'HCB'),
    ('Indeno[123-cd]pyrene', 'kg', 'IcdP'),
    ('Lindane', 't', 'γ-HCH'),
    ('Naphthalene', 'kg', 'NAP'),
    ('Octabromodiphenyl ether', 'kg', 'BDE-183'),
    ('Pentabromodiphenyl Ether', 'kg', 'BDE-99'),
    ('Pentachlorophenol', 't', 'PCP'),
    ('Phenanthrene', 'kg', 'PHE'),
    ('Polychlorinated biphenyls', 'kg', 'PCBs'),
    ('Pyrene', 'kg', 'PYR'),
    ('Short Chain Chlorinated Paraffins (C10-13)', 'kg', 'SCCPs'),
    ('Arsenic', 'kilotonne', 'As'),
    ('Beryllium', 'kilotonne', 'Be'),
    ('Cadmium', 'kilotonne', 'Cd'),
    ('Calcium', 't', 'Ca'),
    ('Chromium', 'kilotonne', 'Cr'),
    ('Copper', 'kilotonne', 'Cu'),
    ('Lead', 'kilotonne', 'Pb'),
    ('Magnesium', 't', 'Mg'),
    ('Manganese', 'kilotonne', 'Mn'),
    ('Mercury', 'kilotonne', 'Hg'),
    ('Nickel', 'kilotonne', 'Ni'),
    ('Potassium', 't', 'K'),
    ('Selenium', 'kilotonne', 'Se'),
    ('Sodium', 't', 'Na'),
    ('Tin', 'kilotonne', 'Sn'),
    ('Vanadium', 'kilotonne', 'V'),
    ('Zinc', 'kilotonne', 'Zn'),
    ('13-butadiene', 'kilotonne', '13-BD'),
    ('Ammonia', 'kilotonne', 'NH3'),
    ('Benzene', 'kilotonne', 'C6H6'),
    ('Black Smoke', 'kilotonne', 'BS'),
    ('Carbon Monoxide', 'kilotonne', 'CO'),
    ('Hydrogen Chloride', 'kilotonne', 'HCl'),
    ('Hydrogen Fluoride', 'kilotonne', 'HF'),
    ('Methane', 'kilotonne', 'CH4'),
    ('Nitrogen Oxides as NO2', 'kilotonne', 'NOx'),
    ('Non Methane VOC', 'kilotonne', 'NMVOC'),
    ('Sulphur Dioxide', 'kilotonne', 'SO2'),
    ('16PAH', 'kg', '16PAH'),
    ('Activity Data', 'TJ (net)', 'ActData'),
    ('Carbon Dioxide as Carbon', 'kilotonne', 'CO2-C'),
    ('HFCs', 'kt CO2 equivalent', 'HFCs'),
    ('NF3', 'kt CO2 equivalent', 'NF3'),
    ('Nitrous Oxide', 'kilotonne', 'N2O'),
    ('PFCs', 'kt CO2 equivalent', 'PFCs'),
    ('Sulphur hexafluoride', 'kt CO2 equivalent', 'SF6'),
    ('Total GHGs in CO2 Eq.', 'kilotonne', 'GHG-CO2-eq')
)
select phen.id, phen.label, phen.notation, phen.eionet_uri
from phenomena phen
left join ref
  on lower(phen.label) = lower(ref.pollutant)
  or lower(phen.notation) = lower(ref.short_pollutant)
  or lower(phen.notation) = lower(ref.pollutant)
where ref.pollutant is null
order by phen.label;
