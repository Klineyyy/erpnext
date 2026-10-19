// Unit tests for erpnext.utils.set_item_tax_withholding_category, which re-applies the
// item rows' Tax Withholding Category after the party of an invoice changes.
// The desk script is evaluated in a sandbox with stubbed frappe globals; run with
// `node --test erpnext/tests/js`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// values built inside the sandbox carry that realm's prototypes; strip them before strict comparisons
const plain = (value) => JSON.parse(JSON.stringify(value));

const SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public/js/utils/party.js"
);

function load_party_utils(item_categories) {
  const calls = { get_list: [], set_value: [] };
  const sandbox = { console };

  sandbox.frappe = {
    provide(namespace) {
      let object = sandbox;
      for (const part of namespace.split(".")) {
        object[part] = object[part] || {};
        object = object[part];
      }
    },
    db: {
      get_list(doctype, args) {
        calls.get_list.push({ doctype, args });
        const [, names] = args.filters.name;
        const field = args.fields[1];
        return Promise.resolve(
          names.map((name) => ({
            name,
            [field]: item_categories[name] || null,
          }))
        );
      },
    },
    model: {
      set_value(doctype, name, fieldname, value) {
        calls.set_value.push({ doctype, name, fieldname, value });
      },
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, "utf8"), sandbox, {
    filename: SOURCE,
  });

  return { calls, utils: sandbox.erpnext.utils };
}

function make_frm(party_category, item_codes) {
  return {
    tax_withholding_category: party_category,
    doc: {
      items: item_codes.map((item_code, index) => ({
        doctype: "Purchase Invoice Item",
        name: `row-${index + 1}`,
        item_code,
        tax_withholding_category: "Category of the previous supplier",
      })),
    },
  };
}

const categories_set = (calls) =>
  Object.fromEntries(calls.set_value.map((call) => [call.name, call.value]));

describe("set_item_tax_withholding_category", () => {
  it("uses the item's own category, else the new party's category", async () => {
    const { calls, utils } = load_party_utils({
      "Contract Work": "Item Category",
    });
    const frm = make_frm("New Supplier Category", [
      "Consulting",
      "Contract Work",
    ]);

    await utils.set_item_tax_withholding_category(
      frm,
      "purchase_tax_withholding_category"
    );

    assert.deepEqual(plain(calls.get_list[0].args.fields), [
      "name",
      "purchase_tax_withholding_category",
    ]);
    assert.deepEqual(categories_set(calls), {
      "row-1": "New Supplier Category",
      "row-2": "Item Category",
    });
  });

  it("clears a stale category when neither the item nor the new party has one", async () => {
    const { calls, utils } = load_party_utils({});
    const frm = make_frm(undefined, ["Consulting"]);

    await utils.set_item_tax_withholding_category(
      frm,
      "purchase_tax_withholding_category"
    );

    assert.deepEqual(categories_set(calls), { "row-1": "" });
  });

  it("skips rows without an item and fetches each item once", async () => {
    const { calls, utils } = load_party_utils({});
    const frm = make_frm("New Supplier Category", [
      "Consulting",
      "Consulting",
      "",
    ]);

    await utils.set_item_tax_withholding_category(
      frm,
      "sales_tax_withholding_category"
    );

    assert.deepEqual(plain(calls.get_list[0].args.filters.name[1]), [
      "Consulting",
    ]);
    assert.deepEqual(Object.keys(categories_set(calls)), ["row-1", "row-2"]);
  });

  it("does not query when there are no items", async () => {
    const { calls, utils } = load_party_utils({});

    await utils.set_item_tax_withholding_category(
      make_frm("Category", []),
      "purchase_tax_withholding_category"
    );

    assert.equal(calls.get_list.length, 0);
  });
});
