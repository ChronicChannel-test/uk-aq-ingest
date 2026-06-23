Yes. Some community or low-cost sensor networks do have QA, but I’d still be careful about calling their readings Verified unless the source explicitly has a final verification or ratification status.

The clean distinction is:

QA / calibration / correction can improve community sensor data.
Verification should mean the source has formally marked the reading as final, checked, ratified, or verified.

Those are related, but not the same.

Examples of community/low-cost sensors with QA or correction

1. PurpleAir with EPA correction

PurpleAir sensors are community low-cost PM sensors, but the US EPA has developed correction methods for using PurpleAir PM2.5 data on the AirNow Fire and Smoke Map. That is a good example of community sensor data being processed with a documented correction approach. It is still not the same as each PurpleAir sensor being an official verified monitor.  

For UK AQ, I’d label that sort of thing as:

Source type: Community
Verification Status: N/A
QA note: Corrected data, where available

Not:

Verification Status: Verified

2. Breathe London-type managed sensor networks

Breathe London is the awkward case. It uses lower-cost sensors in a managed network, so it is not the same as a random community sensor on someone’s wall. But unless the specific dataset you ingest has a clear final verification field, I would still avoid “Verified”. I’d probably still put it under Community for the simple public split, with a note that it is a managed sensor network.

Suggested label:

Source type: Community
Verification Status: N/A
QA note: Managed sensor network

That is simple, but does not pretend it is the same as AURN ratified data.

3. Research or council low-cost networks

There are low-cost networks where sensors are co-located with reference monitors and then calibrated. For example, published low-cost sensor network studies describe field calibration against existing official monitoring infrastructure, and some use humidity/temperature corrections or machine-learning calibration models.  

There is also a recent Oxford/OxAria example where low-cost sensor data was calibrated using co-located reference data, with validation against the Equivalence Spreadsheet Tool.  

For UK AQ, I’d label these as:

Source type: Community
Verification Status: N/A, unless the source publishes final verified readings
QA note: Calibrated / co-located / corrected, if known

Why I would keep “Verified” strict

Your aims document is already leaning towards “quality before quantity” and making clear that not all sensors should be treated equally.   So I’d keep Verification Status very strict.

I’d use:

Situation	Verification Status
Official final/ratified/verified data	Verified
Official live/provisional data	Not verified
Community sensor with no known QA	N/A
Community sensor with calibration/correction/QA but no final verification process	N/A
Community sensor from a network that explicitly publishes final verified readings	Verified, but only if the source clearly says that

Add a third small field later if needed

I think your two main labels should stay simple:

Source type: Official / Community
Verification Status: Verified / Not verified / N/A

Then, if you want to show the extra nuance without cluttering things, add an optional line only where relevant:

QA: None known / Managed / Corrected / Calibrated

But I would not make QA a main badge yet. It may become a rabbit hole.

Best public wording

For community sensors:

N/A means this source does not provide final verified readings in the same way as official monitoring. Some community networks may still apply checks, calibration or correction.

That gives you the clean public message without being unfair to better community networks.