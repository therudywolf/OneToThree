/**
 * The Lite restore's error detection.
 *
 * `node scripts/lite/backup.mjs --restore` feeds a pg_dumpall stream into psql,
 * and psql exits 0 even when every statement in it failed. Without this filter
 * the tool prints "restored" over a database it never replaced — the exact
 * silent-success failure this repo has been bitten by before, and the worst
 * possible shape for a tool people reach for during an incident.
 *
 * The one error that MUST be tolerated is the `DROP ROLE` of the role the
 * restore connection authenticated as: `--clean --if-exists` always emits it,
 * so treating it as fatal would mean no same-cluster restore ever succeeds.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { unexpectedRestoreErrors } from './backup.mjs'

describe('restore error detection', () => {
  test('a clean restore reports nothing', () => {
    assert.deepEqual(
      unexpectedRestoreErrors('SET\nSET\nCREATE DATABASE\nALTER DATABASE\n'),
      []
    )
  })

  test('the self-DROP ROLE pg_dumpall always emits is tolerated', () => {
    const stderr = [
      'ERROR:  current user cannot be dropped',
      'CREATE ROLE',
      'GRANT',
    ].join('\n')
    assert.deepEqual(unexpectedRestoreErrors(stderr), [])
  })

  test('a failed replay is surfaced, not swallowed', () => {
    // What a dump replayed into a cluster that still holds the objects looks
    // like — the case that used to print "restored".
    const stderr = [
      'ERROR:  current user cannot be dropped',
      'ERROR:  relation "users" already exists',
      'ERROR:  duplicate key value violates unique constraint "users_pkey"',
    ].join('\n')
    const found = unexpectedRestoreErrors(stderr)
    assert.equal(found.length, 2)
    assert.match(found[0], /already exists/)
  })

  test('FATAL and PANIC count too, and leading whitespace does not hide them', () => {
    const stderr = '   FATAL:  the database system is in recovery mode\nPANIC:  could not write'
    assert.equal(unexpectedRestoreErrors(stderr).length, 2)
  })

  test('the word ERROR inside ordinary output is not an error line', () => {
    // psql echoes statements; a column or comment containing "error" must not
    // fail an otherwise good restore.
    const stderr = 'COPY 41\n-- ERROR handling notes follow\nNOTICE:  table "error_log" does not exist'
    assert.deepEqual(unexpectedRestoreErrors(stderr), [])
  })

  test('importing the module does not run a backup', () => {
    // The import at the top of this file is the assertion: if the CLI dispatch
    // were not guarded, loading it would have shelled out to docker already.
    assert.equal(typeof unexpectedRestoreErrors, 'function')
  })
})
