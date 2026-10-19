"""Validate shipped SQLite schema and search behavior with native SQLite."""
import pathlib
import re
import sqlite3

root = pathlib.Path(__file__).resolve().parent.parent
source = (root / 'src' / 'database.js').read_text()
match = re.search(r'const PACK_SCHEMA = `([\s\S]*?)`;', source)
assert match, 'Schema declaration missing'
con = sqlite3.connect(':memory:')
con.executescript(match.group(1))
con.execute('INSERT INTO pages VALUES (?,?,?,?)', ('0:1', 'Screens', 0, '{}'))
con.execute('''INSERT INTO nodes(figma_id,parent_id,page_id,position,depth,type,name,
  visible,text,properties_json) VALUES (?,?,?,?,?,?,?,?,?,?)''',
  ('10:2', '10:1', '0:1', 1, 1, 'TEXT', 'Payment header', 1,
   'Your total is 30 €', '{"fontSize":16}'))
con.execute('''CREATE VIRTUAL TABLE nodes_fts USING fts5(name,text,content='nodes',content_rowid='id')''')
con.execute("INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')")
row = con.execute('''SELECT n.figma_id,n.text FROM nodes_fts
  JOIN nodes n ON n.id=nodes_fts.rowid WHERE nodes_fts MATCH 'payment'
  ORDER BY bm25(nodes_fts)''').fetchone()
assert row == ('10:2', 'Your total is 30 €'), row
assert con.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
print('PASS database schema: SQLite integrity and FTS5 search')
