const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DatabaseManager = require("../../src/helpers/database");

function createDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superting-contacts-fusion-"));
  const db = new DatabaseManager({ dbPath: path.join(root, "transcriptions.db") });
  t.after(() => {
    db.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return db;
}

test("upsertContacts creates a person instead of a contacts row", (t) => {
  const db = createDatabase(t);

  db.upsertContacts([{ email: "Ada@Example.com", displayName: "Ada Lovelace" }]);

  const person = db.listPeople("ada@example.com")[0];
  assert.ok(person, "person created from the contact");
  assert.equal(person.display_name, "Ada Lovelace");
  assert.equal(person.email, "ada@example.com", "email is normalized");
  // The legacy contacts table is no longer written.
  assert.equal(db.db.prepare("SELECT COUNT(*) AS c FROM contacts").get().c, 0);
});

test("searchContacts reads people (email and display name), skips email-less people", (t) => {
  const db = createDatabase(t);

  db.findOrCreatePerson({ displayName: "张三", email: "zhangsan@example.com" });
  db.findOrCreatePerson({ displayName: "王浩" }); // no email → not a contact

  const byName = db.searchContacts("张三");
  assert.deepEqual(
    byName.map((c) => c.email),
    ["zhangsan@example.com"]
  );
  const byEmail = db.searchContacts("zhangsan@");
  assert.equal(byEmail.length, 1);
  assert.equal(db.searchContacts("王浩").length, 0);
});

test("upsertContacts upgrades an auto-generated name but never clobbers a real one", (t) => {
  const db = createDatabase(t);

  // Auto-generated name (email prefix) gets upgraded.
  db.upsertContacts([{ email: "liwei@example.com" }]);
  assert.equal(db.listPeople("liwei")[0].display_name, "liwei");
  db.upsertContacts([{ email: "liwei@example.com", displayName: "李维" }]);
  assert.equal(db.listPeople("liwei")[0].display_name, "李维");

  // A name set by the user is kept.
  db.upsertContacts([{ email: "liwei@example.com", displayName: "别的名字" }]);
  assert.equal(db.listPeople("liwei")[0].display_name, "李维");
});

test("migrateLegacyPeople imports pre-existing contacts rows into people", (t) => {
  const db = createDatabase(t);

  db.db
    .prepare("INSERT INTO contacts (email, display_name) VALUES (?, ?)")
    .run("legacy@example.com", "Legacy User");
  db.db.prepare("INSERT INTO contacts (email) VALUES (?)").run("bare@example.com");

  db.migrateLegacyPeople();

  const legacy = db.searchContacts("legacy@example.com");
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].display_name, "Legacy User");
  assert.equal(db.searchContacts("bare@example.com")[0].display_name, "bare");
});
