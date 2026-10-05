/**
 * menu.js - valid-action menu construction for the System-1 executor.
 *
 * Faithful browser port of Executor.validMenu() in teacher/lib/executor.mjs,
 * plus the menu grounding helpers from the executor domain contract
 * (section 2): entry ordering (action_name ascending, ties by params_digest),
 * params_digest labeling (skeleton-time vs execution-time), and the
 * argmax-to-menu-entry mapping from the ONNX I/O contract (section 2).
 *
 * UMD: runs in browsers and Node. No network, no storage, no em dashes.
 */
(function (root, factory) {
  "use strict";
  var api = factory(root.S1Util);
  if (typeof module === "object" && module !== null && typeof module.exports === "object") {
    module.exports = api;
  } else {
    root.S1Menu = api;
  }
})(typeof self !== "undefined" ? self : this, function (U) {
  "use strict";

  if (!U) throw new Error("menu.js requires s1util.js (S1Util) to load first.");

  /**
   * Order menu entries: action_name ascending (plain string comparison, as in
   * executor.mjs), ties broken by params_digest ascending (domain contract
   * 2.3; action names are unique in practice so the tie-break never fires).
   */
  function sortMenu(menu) {
    var withDigest = menu.map(function (e) {
      return { entry: e, digest: U.digest8(e.params) };
    });
    withDigest.sort(function (x, y) {
      var a = x.entry.action_name, b = y.entry.action_name;
      if (a < b) return -1;
      if (a > b) return 1;
      if (x.digest < y.digest) return -1;
      if (x.digest > y.digest) return 1;
      return 0;
    });
    return withDigest.map(function (w) { return w.entry; });
  }

  /**
   * The valid-action menu: a closed deterministic function of the current
   * recipe item and session state. Port of Executor.validMenu().
   *
   * @param {object} ex the Executor instance (reads ex._items, ex._itemIndex,
   *   ex._flagOpen(), ex._undoable()).
   * @returns {Array<{action_name: string, params: object}>} at most 5 entries.
   */
  function validMenu(ex) {
    var menu = [];
    var flagOpen = ex._flagOpen();
    if (!flagOpen && ex._itemIndex < ex._items.length) {
      var item = ex._items[ex._itemIndex];
      menu.push({ action_name: item.intent, params: U.deepCopy(item.params) });
      menu.push({ action_name: "skip_recipe_item", params: { item_index: ex._itemIndex } });
    }
    if (ex._undoable()) menu.push({ action_name: "undo_last", params: {} });
    /* flag_for_review is unparameterized in the menu; it targets the
       current item by default when no node_id/item_index is supplied. */
    menu.push({ action_name: "flag_for_review", params: {} });
    menu.push({ action_name: "abort_session", params: {} });
    return sortMenu(menu);
  }

  /**
   * Field objects for the menu token section, in menu order.
   * Menu token fields carry ONLY action_name + params_digest (contract 5).
   * @param {Array} menu sorted menu entries.
   * @param {string} digestKind "skeleton" (menu-time params) or "executed"
   *   (full params after operator authoring); the UI must label which one it
   *   emits (domain contract Q3). The live loop emits "skeleton".
   * @returns {Array<{action_name: string, params_digest: string}>}
   */
  function menuTokenFields(menu, digestKind) {
    return menu.map(function (e) {
      return { action_name: e.action_name, params_digest: U.digest8(e.params) };
    });
  }

  /**
   * Map a full-sequence argmax index to the menu entry. The N-th menu token
   * (N = number of menu-masked positions at or before that index, minus 1)
   * maps to the N-th entry of the menu array built in the same order.
   * Port of the reference mapping in training/smoke/infer.mjs.
   */
  function entryForArgmax(menu, argmaxIndex, isMenuPosition) {
    var count = 0;
    for (var i = 0; i <= argmaxIndex; i++) {
      if (isMenuPosition(i)) count++;
    }
    var menuIndex = count - 1;
    if (menuIndex < 0 || menuIndex >= menu.length) {
      throw new Error("argmax mapped to menu index " + menuIndex + " of " + menu.length + " entries.");
    }
    return { menuIndex: menuIndex, entry: menu[menuIndex] };
  }

  return {
    sortMenu: sortMenu,
    validMenu: validMenu,
    menuTokenFields: menuTokenFields,
    entryForArgmax: entryForArgmax
  };
});
