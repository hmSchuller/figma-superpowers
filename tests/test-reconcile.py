"""Replay a change report and a node snapshot through the documented operations.

This validates the reconciliation semantics independently of Figma: whole-row creates,
merge patches, subtree deletes, token create/patch/cascade delete, snapshot upserts and
FTS/ integrity after applying.
"""
import pathlib
import re
import sqlite3

root = pathlib.Path(__file__).resolve().parent.parent
source = (root / 'src' / 'database.js').read_text()
schema = re.search(r'const PACK_SCHEMA = `([\s\S]*?)`;', source).group(1)

con = sqlite3.connect(':memory:')
con.executescript(schema)

con.execute('INSERT INTO pages VALUES (?,?,?,?)', ('0:1', 'Screens', 0, '{}'))
NODE_COLS = ('figma_id,parent_id,page_id,position,depth,type,name,visible,x,y,width,'
             'height,text,component_key,properties_json')

def add_node(fid, parent, page, pos, depth, type_, name, **kw):
    con.execute(f'INSERT INTO nodes({NODE_COLS}) VALUES ({",".join("?" * 15)})',
                (fid, parent, page, pos, depth, type_, name, 1, kw.get('x', 0), kw.get('y', 0),
                 kw.get('width', 100), kw.get('height', 40), kw.get('text'), None, '{}'))

add_node('10:1', '0:1', '0:1', 0, 0, 'FRAME', 'Checkout')
add_node('10:2', '10:1', '0:1', 0, 1, 'TEXT', 'Heading', text='Pay securely')
add_node('10:3', '10:1', '0:1', 1, 1, 'TEXT', 'Body')
add_node('10:4', '0:1', '0:1', 1, 0, 'FRAME', 'Old')
add_node('10:5', '10:4', '0:1', 0, 1, 'TEXT', 'OldChild')
con.execute('INSERT INTO variable_collections VALUES (?,?,?,?,?,?)',
            ('C:1', 'Theme', 'c1', 'M:1', 0, '{}'))
con.execute('INSERT INTO variable_modes VALUES (?,?,?,?)', ('C:1', 'M:1', 'Light', 0))
con.execute('INSERT INTO variables VALUES (?,?,?,?,?,?,?)',
            ('V:1', 'C:1', 'color/primary', None, 'COLOR', '', '{}'))
con.execute('INSERT INTO variables VALUES (?,?,?,?,?,?,?)',
            ('V:2', 'C:1', 'color/legacy', None, 'COLOR', '', '{}'))
con.execute('INSERT INTO variable_values VALUES (?,?,?,?)', ('V:1', 'M:1', '{"old":1}', None))
con.execute('INSERT INTO variable_values VALUES (?,?,?,?)', ('V:2', 'M:1', '{"old":2}', None))
con.execute('INSERT INTO styles VALUES (?,?,?,?,?,?)', ('S:old', None, 'Retired', 'PAINT', '', '{}'))

# ---- sample payloads ---------------------------------------------------

report = {
    'kind': 'CHANGE_REPORT',
    'counts': {'created': 1, 'updated': 1, 'deleted': 2, 'tokens': 4},
    'created': [{
        'node': {'figma_id': '12:7', 'parent_id': '10:1', 'page_id': '0:1', 'position': 2,
                 'depth': 1, 'type': 'FRAME', 'name': 'Card', 'visible': 1, 'x': 0, 'y': 0,
                 'width': 320, 'height': 200, 'text': None, 'component_key': None,
                 'properties_json': '{}'},
        'bindings': [{'node_id': '12:7', 'field': 'fills[0]', 'variable_id': 'V:1'}],
        'links': [{'source_id': '12:7', 'target_id': '20:1', 'kind': 'instance', 'label': 'Button'}]
    }],
    'updated': [{'figma_id': '10:2', 'set': {'name': 'Card 2', 'width': 340}}],
    'deleted': ['10:3', '10:4'],
    'tokens': {
        'created': [{'kind': 'variable', 'data': {
            'figma_id': 'V:9', 'collection_id': 'C:1', 'name': 'space/m', 'key': None,
            'resolved_type': 'FLOAT', 'description': '', 'properties_json': '{}'}}],
        'updated': [{'kind': 'value', 'key': {'variable_id': 'V:1', 'mode_id': 'M:1'},
                     'set': {'value_json': '{"new":9}', 'alias_variable_id': None}}],
        'deleted': [{'kind': 'variable', 'figma_id': 'V:2'},
                    {'kind': 'style', 'figma_id': 'S:old'}]
    },
    'geometry_stale': True,
    'truncated': False
}
snapshot = {
    'kind': 'NODE_SNAPSHOT', 'page_id': '0:1', 'node_count': 1,
    'nodes': [{'node': {'figma_id': '12:9', 'parent_id': '0:1', 'page_id': '0:1',
                        'position': 1, 'depth': 0, 'type': 'FRAME', 'name': 'Header',
                        'visible': 1, 'x': 0, 'y': 0, 'width': 1440, 'height': 80,
                        'text': None, 'component_key': None, 'properties_json': '{}'},
               'bindings': [], 'links': []}]
}

# ---- envelope completeness (declared totals must match the arrays) -----

def verify_counts(payload):
    tokens = payload['tokens']
    ops = len(tokens['created']) + len(tokens['updated']) + len(tokens['deleted'])
    return (payload['counts']['created'] == len(payload['created']) and
            payload['counts']['updated'] == len(payload['updated']) and
            payload['counts']['deleted'] == len(payload['deleted']) and
            payload['counts']['tokens'] == ops)

assert verify_counts(report), 'report totals must match its arrays'
assert snapshot['node_count'] == len(snapshot['nodes']), 'snapshot total must match its array'

# ---- apply the report --------------------------------------------------

def insert_node(row):
    con.execute(f'INSERT OR REPLACE INTO nodes({NODE_COLS})'
                f' VALUES ({",".join("?" * 15)})',
                (row['figma_id'], row['parent_id'], row['page_id'], row['position'], row['depth'],
                 row['type'], row['name'], row['visible'], row.get('x'), row.get('y'),
                 row.get('width'), row.get('height'), row.get('text'), row.get('component_key'),
                 row.get('properties_json', '{}')))

def insert_row(table, row):
    cols = list(row.keys())
    con.execute(f'INSERT OR REPLACE INTO {table}({",".join(cols)})'
                f' VALUES ({",".join("?" * len(cols))})', [row[c] for c in cols])

def delete_subtree(root_id):
    con.execute('''WITH RECURSIVE tree(figma_id) AS (
        SELECT figma_id FROM nodes WHERE figma_id=?
        UNION ALL SELECT n.figma_id FROM nodes n JOIN tree t ON n.parent_id=t.figma_id)
        DELETE FROM node_variable_bindings WHERE node_id IN (SELECT figma_id FROM tree)''',
                (root_id,))
    con.execute('''WITH RECURSIVE tree(figma_id) AS (
        SELECT figma_id FROM nodes WHERE figma_id=?
        UNION ALL SELECT n.figma_id FROM nodes n JOIN tree t ON n.parent_id=t.figma_id)
        DELETE FROM node_links WHERE source_id IN (SELECT figma_id FROM tree)''', (root_id,))
    con.execute('''WITH RECURSIVE tree(figma_id) AS (
        SELECT figma_id FROM nodes WHERE figma_id=?
        UNION ALL SELECT n.figma_id FROM nodes n JOIN tree t ON n.parent_id=t.figma_id)
        DELETE FROM nodes WHERE figma_id IN (SELECT figma_id FROM tree)''', (root_id,))

def apply_update(entry):
    fields = list(entry['set'].keys())
    con.execute(f'UPDATE nodes SET {",".join(f"{f}=?" for f in fields)} WHERE figma_id=?',
                [entry['set'][f] for f in fields] + [entry['figma_id']])
    if 'bindings' in entry:
        con.execute('DELETE FROM node_variable_bindings WHERE node_id=?', (entry['figma_id'],))
        for binding in entry['bindings']:
            insert_row('node_variable_bindings', binding)
    if 'links' in entry:
        con.execute('DELETE FROM node_links WHERE source_id=?', (entry['figma_id'],))
        for link in entry['links']:
            insert_row('node_links', link)

def apply_token(entry):
    kind, data = entry['kind'], entry['data']
    if kind == 'variable':
        insert_row('variables', data)
    elif kind == 'collection':
        insert_row('variable_collections', data)
    elif kind == 'mode':
        insert_row('variable_modes', data)
    elif kind == 'value':
        insert_row('variable_values', data)
    elif kind == 'style':
        insert_row('styles', data)

def apply_token_patch(entry):
    key = entry['key']
    where = ' AND '.join(f'{col}=?' for col in key)
    values = list(entry['set'].values()) + list(key.values())
    if entry['kind'] == 'value':
        existing = con.execute(
            f'SELECT count(*) FROM variable_values WHERE {where}', list(key.values())).fetchone()[0]
        if existing:
            con.execute(f'UPDATE variable_values SET {",".join(f"{c}=?" for c in entry["set"])}'
                        f' WHERE {where}', values)
        else:
            insert_row('variable_values', dict(entry['set'], **key))
    elif entry['kind'] == 'variable':
        con.execute(f'UPDATE variables SET {",".join(f"{c}=?" for c in entry["set"])}'
                    f' WHERE {where}', values)
    elif entry['kind'] == 'style':
        con.execute(f'UPDATE styles SET {",".join(f"{c}=?" for c in entry["set"])}'
                    f' WHERE {where}', values)

def apply_token_delete(entry):
    kind = entry['kind']
    if kind == 'variable':
        con.execute('DELETE FROM variable_values WHERE variable_id=?', (entry['figma_id'],))
        con.execute('DELETE FROM variables WHERE figma_id=?', (entry['figma_id'],))
    elif kind == 'collection':
        con.execute('''DELETE FROM variable_values WHERE variable_id IN
            (SELECT figma_id FROM variables WHERE collection_id=?)''', (entry['figma_id'],))
        con.execute('DELETE FROM variables WHERE collection_id=?', (entry['figma_id'],))
        con.execute('DELETE FROM variable_modes WHERE collection_id=?', (entry['figma_id'],))
        con.execute('DELETE FROM variable_collections WHERE figma_id=?', (entry['figma_id'],))
    elif kind == 'style':
        con.execute('DELETE FROM styles WHERE figma_id=?', (entry['figma_id'],))

for created in report['created']:
    insert_node(created['node'])
    for binding in created['bindings']:
        insert_row('node_variable_bindings', binding)
    for link in created['links']:
        insert_row('node_links', link)
for entry in report['updated']:
    apply_update(entry)
for node_id in report['deleted']:
    delete_subtree(node_id)
for entry in report['tokens']['created']:
    apply_token(entry)
for entry in report['tokens']['updated']:
    apply_token_patch(entry)
for entry in report['tokens']['deleted']:
    apply_token_delete(entry)

# ---- apply the snapshot (upsert-only) ----------------------------------

for node in snapshot['nodes']:
    insert_node(node['node'])
    for binding in node['bindings']:
        insert_row('node_variable_bindings', binding)
    for link in node['links']:
        insert_row('node_links', link)

# ---- assert ------------------------------------------------------------

def scalar(sql, args=()):
    return con.execute(sql, args).fetchone()[0]

assert scalar("SELECT count(*) FROM nodes WHERE figma_id='12:7'") == 1
assert scalar("SELECT parent_id FROM nodes WHERE figma_id='12:7'") == '10:1'
assert scalar("SELECT count(*) FROM node_variable_bindings WHERE node_id='12:7'") == 1
assert scalar("SELECT count(*) FROM node_links WHERE source_id='12:7'") == 1
assert con.execute("SELECT name,width FROM nodes WHERE figma_id='10:2'").fetchone() == ('Card 2', 340)
assert scalar("SELECT count(*) FROM nodes WHERE figma_id IN ('10:3','10:4','10:5')") == 0, \
    'subtree delete removes the root and its descendants'
assert scalar("SELECT count(*) FROM variables WHERE figma_id='V:9'") == 1
assert con.execute("SELECT value_json FROM variable_values WHERE variable_id='V:1'").fetchone()[0] \
    == '{"new":9}'
assert scalar("SELECT count(*) FROM variables WHERE figma_id='V:2'") == 0
assert scalar("SELECT count(*) FROM variable_values WHERE variable_id='V:2'") == 0, \
    'variable delete cascades to its values'
assert scalar("SELECT count(*) FROM styles WHERE figma_id='S:old'") == 0
assert scalar("SELECT name FROM nodes WHERE figma_id='12:9'") == 'Header', 'snapshot upsert landed'

con.execute("CREATE VIRTUAL TABLE nodes_fts USING fts5(name,text,content='nodes',content_rowid='id')")
con.execute("INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')")
hit = con.execute("SELECT n.figma_id FROM nodes_fts JOIN nodes n ON n.id=nodes_fts.rowid "
                  "WHERE nodes_fts MATCH 'Header'").fetchone()
assert hit == ('12:9',), hit

assert con.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
print('PASS reconcile: report + snapshot applied to SQLite with cascades, FTS and integrity intact')
