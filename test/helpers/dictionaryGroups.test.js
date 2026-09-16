const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DatabaseManager = require("../../src/helpers/database");

function createDatabase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superting-dictionary-groups-"));
  const db = new DatabaseManager({ dbPath: path.join(root, "transcriptions.db") });
  t.after(() => {
    db.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return db;
}

function byName(db, name) {
  return db.listDictionaryGroups().find((group) => group.name === name);
}

test("dictionary groups support nesting and are listed parent-first", (t) => {
  const db = createDatabase(t);

  const parent = db.createDictionaryGroup("工作").group;
  const child = db.createDictionaryGroup("项目A", parent.id).group;

  assert.equal(parent.parentId, null);
  assert.equal(child.parentId, parent.id);

  const groups = db.listDictionaryGroups();
  assert.equal(groups.length, 2);
  // NULL parents sort first, children carry their parentId.
  assert.deepEqual(
    groups.map((group) => [group.name, group.parentId]),
    [
      ["工作", null],
      ["项目A", parent.id],
    ]
  );
  assert.equal(groups[0].itemCount, 0);
});

test("createDictionaryGroup trims the name and rejects empty names / missing parents", (t) => {
  const db = createDatabase(t);

  assert.equal(db.createDictionaryGroup("  客户  ").group.name, "客户");
  assert.throws(() => db.createDictionaryGroup("   "), /Group name is required/);
  assert.throws(() => db.createDictionaryGroup("x", 9999), /does not exist/);
});

test("sibling group names must be unique, different parents may repeat a name", (t) => {
  const db = createDatabase(t);
  const parentA = db.createDictionaryGroup("A").group;
  const parentB = db.createDictionaryGroup("B").group;

  assert.equal(db.createDictionaryGroup("客户", parentA.id).group.name, "客户");
  // Same name under the same parent → rejected with a machine-readable code.
  assert.throws(
    () => db.createDictionaryGroup("客户", parentA.id),
    (error) => error.code === "duplicate-group-name"
  );
  // Same name under a different parent is fine.
  const clientUnderB = db.createDictionaryGroup("客户", parentB.id).group;
  assert.equal(clientUnderB.name, "客户");

  // Renaming is guarded case-insensitively as well.
  const other = db.createDictionaryGroup("其它", parentB.id).group;
  assert.throws(
    () => db.renameDictionaryGroup(other.id, "客户"),
    (error) => error.code === "duplicate-group-name"
  );
  // Renaming to its own name (excluded) stays allowed.
  assert.equal(db.renameDictionaryGroup(other.id, "其它").success, true);
});

test("moveDictionaryGroup re-parents a subtree and refuses cycles", (t) => {
  const db = createDatabase(t);
  const root = db.createDictionaryGroup("根").group;
  const middle = db.createDictionaryGroup("中间", root.id).group;
  const leaf = db.createDictionaryGroup("叶子", middle.id).group;
  const other = db.createDictionaryGroup("其它").group;

  // Move the middle subtree (with its leaf) under "其它".
  assert.deepEqual(db.moveDictionaryGroup(middle.id, other.id), {
    success: true,
    movedId: middle.id,
    parentId: other.id,
  });
  assert.equal(byName(db, "中间").parentId, other.id);
  assert.equal(byName(db, "叶子").parentId, middle.id);

  // Back to the root.
  db.moveDictionaryGroup(middle.id, null);
  assert.equal(byName(db, "中间").parentId, null);

  // Self / own descendant targets are refused.
  assert.throws(
    () => db.moveDictionaryGroup(middle.id, middle.id),
    (error) => error.code === "group-cycle"
  );
  db.moveDictionaryGroup(leaf.id, middle.id);
  assert.throws(
    () => db.moveDictionaryGroup(middle.id, leaf.id),
    (error) => error.code === "group-cycle"
  );
});

test("deleteDictionaryGroup returns a snapshot that restores the exact tree", (t) => {
  const db = createDatabase(t);
  const root = db.createDictionaryGroup("根").group;
  const middle = db.createDictionaryGroup("中间", root.id).group;
  const leaf = db.createDictionaryGroup("叶子", middle.id).group;

  db.setDictionary(["Alpha", "Beta"]);
  db.setDictionaryAliases([{ from: "antibus", to: "EntVerse" }]);
  db.setDictionaryGroup({ itemType: "word", key: "Beta", groupId: middle.id });
  db.setDictionaryGroup({ itemType: "alias", key: "antibus", groupId: leaf.id });
  db.setDictionaryGroup({ itemType: "word", key: "Alpha", groupId: leaf.id });

  const result = db.deleteDictionaryGroup(middle.id);
  assert.equal(result.success, true);
  assert.equal(result.deletedName, "中间");
  assert.equal(result.reparentedCount, 1);
  assert.equal(result.ungroupedCount, 1);
  assert.ok(result.snapshot?.groups?.length === 3);

  const beforeRestore = db.listDictionaryGroupAssignments();
  assert.equal(beforeRestore.words.Beta, undefined);
  assert.equal(beforeRestore.words.Alpha, leaf.id);

  const restored = db.restoreDictionaryGroups(result.snapshot);
  assert.equal(restored.success, true);
  assert.equal(restored.restored, 3);
  assert.equal(byName(db, "中间").parentId, root.id);
  assert.equal(byName(db, "叶子").parentId, middle.id);
  assert.deepEqual(db.listDictionaryGroupAssignments(), {
    words: { Beta: middle.id, Alpha: leaf.id },
    aliases: { antibus: leaf.id },
  });
});

test("renameDictionaryGroup updates the name and rejects unknown groups", (t) => {
  const db = createDatabase(t);
  const group = db.createDictionaryGroup("旧名").group;

  const renamed = db.renameDictionaryGroup(group.id, "  新名  ");
  assert.equal(renamed.success, true);
  assert.equal(renamed.group.name, "新名");
  assert.equal(byName(db, "新名").name, "新名");

  assert.throws(() => db.renameDictionaryGroup(group.id, "  "), /Group name is required/);
  assert.throws(() => db.renameDictionaryGroup(4242, "x"), /does not exist/);
});

test("deleteDictionaryGroup re-parents children and ungroups its items", (t) => {
  const db = createDatabase(t);
  const root = db.createDictionaryGroup("根").group;
  const middle = db.createDictionaryGroup("中间", root.id).group;
  const leaf = db.createDictionaryGroup("叶子", middle.id).group;

  db.setDictionary(["Alpha", "Beta"]);
  db.setDictionaryAliases([{ from: "antibus", to: "EntVerse" }]);
  db.setDictionaryGroup({ itemType: "word", key: "Alpha", groupId: leaf.id });
  db.setDictionaryGroup({ itemType: "word", key: "Beta", groupId: middle.id });
  db.setDictionaryGroup({ itemType: "alias", key: "antibus", groupId: middle.id });

  const result = db.deleteDictionaryGroup(middle.id);
  assert.equal(result.success, true);
  assert.equal(result.reparentedTo, root.id);

  const groups = db.listDictionaryGroups();
  assert.deepEqual(
    groups.map((group) => group.name).sort(),
    ["叶子", "根"]
  );
  assert.equal(byName(db, "叶子").parentId, root.id);

  const assignments = db.listDictionaryGroupAssignments();
  // Alpha kept its (now orphan-free) leaf group, the deleted group's items
  // fell back to ungrouped.
  assert.equal(assignments.words.Alpha, leaf.id);
  assert.equal(assignments.words.Beta, undefined);
  assert.equal(assignments.aliases.antibus, undefined);
  // The words themselves are untouched.
  assert.deepEqual(db.getDictionary(), ["Alpha", "Beta"]);
  assert.deepEqual(db.getDictionaryAliases(), [{ from: "antibus", to: "EntVerse" }]);
});

test("setDictionaryGroup moves words and aliases, and null ungroups them", (t) => {
  const db = createDatabase(t);
  const group = db.createDictionaryGroup("会议").group;

  db.setDictionary(["SuperTing", "EntVerse"]);
  db.setDictionaryAliases([{ from: "Antibus", to: "EntVerse" }]);

  assert.deepEqual(db.setDictionaryGroup({ itemType: "word", key: "SuperTing", groupId: group.id }), {
    success: true,
    updated: 1,
    groupId: group.id,
  });
  assert.deepEqual(db.setDictionaryGroup({ itemType: "alias", key: "Antibus", groupId: group.id }), {
    success: true,
    updated: 1,
    groupId: group.id,
  });

  assert.deepEqual(db.listDictionaryGroupAssignments(), {
    words: { SuperTing: group.id },
    aliases: { Antibus: group.id },
  });
  assert.equal(byName(db, "会议").itemCount, 2);
  assert.deepEqual(db.getDictionaryGroupsForItems(), db.listDictionaryGroupAssignments());

  // Moving back to "ungrouped" clears the assignment.
  assert.equal(
    db.setDictionaryGroup({ itemType: "word", key: "SuperTing", groupId: null }).updated,
    1
  );
  assert.deepEqual(db.listDictionaryGroupAssignments().words, {});

  // Unknown items are a no-op, invalid payloads throw.
  assert.equal(db.setDictionaryGroup({ itemType: "word", key: "Missing", groupId: null }).updated, 0);
  assert.throws(
    () => db.setDictionaryGroup({ itemType: "nope", key: "x", groupId: null }),
    /itemType must be/
  );
  assert.throws(() => db.setDictionaryGroup({ itemType: "word", key: "  ", groupId: null }), /key/);
  assert.throws(
    () => db.setDictionaryGroup({ itemType: "word", key: "EntVerse", groupId: 777 }),
    /does not exist/
  );
});

test("setDictionary keeps group assignments across a full-table rewrite", (t) => {
  const db = createDatabase(t);
  const kept = db.createDictionaryGroup("保留").group;
  const dropped = db.createDictionaryGroup("丢弃").group;

  db.setDictionary(["Alpha", "Beta"]);
  db.setDictionaryGroup({ itemType: "word", key: "Alpha", groupId: kept.id });
  db.setDictionaryGroup({ itemType: "word", key: "Beta", groupId: dropped.id });

  // Rewrite the whole list: Alpha survives, Beta is removed, Gamma is new.
  db.setDictionary(["Alpha", "Gamma"]);

  const assignments = db.listDictionaryGroupAssignments();
  assert.equal(assignments.words.Alpha, kept.id);
  assert.equal(assignments.words.Beta, undefined);
  assert.equal(assignments.words.Gamma, undefined);
  assert.deepEqual(db.getDictionary(), ["Alpha", "Gamma"]);
});

test("setDictionaryAliases keeps group assignments across a full-table rewrite", (t) => {
  const db = createDatabase(t);
  const group = db.createDictionaryGroup("纠错").group;

  db.setDictionaryAliases([
    { from: "Antibus", to: "EntVerse" },
    { from: "old", to: "new" },
  ]);
  db.setDictionaryGroup({ itemType: "alias", key: "Antibus", groupId: group.id });

  db.setDictionaryAliases([
    { from: "Antibus", to: "EntVerse" },
    { from: "fresh", to: "Fresh" },
  ]);

  const assignments = db.listDictionaryGroupAssignments();
  assert.equal(assignments.aliases.Antibus, group.id);
  assert.equal(assignments.aliases.old, undefined);
  assert.equal(assignments.aliases.fresh, undefined);
});

test("group assignments survive a database reopen", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superting-dictionary-groups-"));
  const dbPath = path.join(root, "transcriptions.db");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const db = new DatabaseManager({ dbPath });
  const group = db.createDictionaryGroup("持久").group;
  db.setDictionary(["Alpha"]);
  db.setDictionaryGroup({ itemType: "word", key: "Alpha", groupId: group.id });
  db.db.close();
  db.db = null;

  const reopened = new DatabaseManager({ dbPath });
  t.after(() => reopened.cleanup());

  const groups = reopened.listDictionaryGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "持久");
  assert.deepEqual(reopened.listDictionaryGroupAssignments(), {
    words: { Alpha: groups[0].id },
    aliases: {},
  });
});
