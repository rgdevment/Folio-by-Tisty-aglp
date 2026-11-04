-- One row per network and action, reset within itself each hour: the network's name changes every day (decision 137).
CREATE TABLE net_hour (
  net TEXT NOT NULL,
  action TEXT NOT NULL,
  hour INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (net, action)
) WITHOUT ROWID;
