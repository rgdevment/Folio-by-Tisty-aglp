-- One row, written only when the stage changes (decision 118). With no row, the service is open.
CREATE TABLE service_stage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stage TEXT NOT NULL
) WITHOUT ROWID;
