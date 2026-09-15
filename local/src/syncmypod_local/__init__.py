"""SyncMyPod local sync app.

The only component of SyncMyPod that touches audio or the iPod itself. The web
tool holds library data and never sees a byte of music; this downloads what is
missing, tags it from the server's resolved metadata, writes it to the device,
and deletes every downloaded file once the transfer is confirmed.
"""

__version__ = "0.2.0"
