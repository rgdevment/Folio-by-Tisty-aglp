CREATE INDEX docs_by_owner ON docs (json_extract(body, '$.owner'));
