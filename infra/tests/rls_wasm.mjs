// Complementary portable check against PostgreSQL in WASM. CI also runs native PostgreSQL.
// Set PGLITE_MODULE to an absolute path to @electric-sql/pglite/dist/index.js if not installed here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const moduleName = process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE).href : '@electric-sql/pglite';
const { PGlite } = await import(moduleName);
const db = new PGlite();
const sql = await readFile(new URL('../postgres/schema.sql', import.meta.url), 'utf8');
await db.exec(sql);
await db.exec('SET ROLE app_runtime');
await db.exec('BEGIN');
await db.query("SELECT set_config('app.user_id', $1, true)", ['alice']);
const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
const forged = '00000000-0000-4000-8000-000000000003';
await db.query("INSERT INTO tracks(id,owner_id,title,metadata,midi) VALUES($1,'alice','A','{}',decode('4d546864','hex'))", [first]);
await db.query("SELECT set_config('app.user_id', $1, true)", ['bob']);
await db.query("INSERT INTO tracks(id,owner_id,title,metadata,midi) VALUES($1,'bob','B','{}',decode('4d546864','hex'))", [second]);
assert.deepEqual((await db.query('SELECT id FROM tracks')).rows, [{ id: second }]);
assert.equal((await db.query('SELECT midi FROM tracks WHERE id=$1', [first])).rows.length, 0);
assert.equal((await db.query("UPDATE tracks SET title='stolen' WHERE id=$1 RETURNING id", [first])).rows.length, 0);
assert.equal((await db.query('DELETE FROM tracks WHERE id=$1 RETURNING id', [first])).rows.length, 0);
for (const [statement, values] of [
  ["INSERT INTO tracks(id,owner_id,title,metadata,midi) VALUES($1,'alice','forged','{}',decode('4d546864','hex'))", [forged]],
  ["UPDATE tracks SET owner_id='alice' WHERE id=$1", [second]],
]) {
  await db.exec('SAVEPOINT expected_failure');
  await assert.rejects(db.query(statement, values), error => error.code === '42501');
  await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure');
}
await db.exec("SELECT set_config('app.user_id', '', true)");
assert.deepEqual((await db.query('SELECT id FROM tracks')).rows, []);
await db.exec('ROLLBACK');
assert.equal((await db.query("SELECT NULLIF(current_setting('app.user_id', true), '') AS identity")).rows[0].identity, null);
const role = (await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
assert.equal(role.rolsuper, false);
assert.equal(role.rolbypassrls, false);
await db.close();
console.log('Passed PostgreSQL WASM RLS probes: scoped reads, download, update, delete, forged owner, missing identity, transaction reset, runtime role.');
