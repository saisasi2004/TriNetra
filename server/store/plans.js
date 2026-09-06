/**
 * Floor plan store.
 *
 * Plans are JSON documents under `data/plans/`, plus a small set of built-ins
 * compiled into the app. One of them is ACTIVE at any moment, and the active
 * plan is what defines the sensing space: its footprint becomes the room
 * size, its rooms become zones, and its node placements become node
 * positions.
 *
 * Built-ins are read-only on purpose. The default flat is the layout every
 * install starts from and every screenshot shows; letting it be edited in
 * place would make "the default plan" mean something different on every
 * machine. Editing one duplicates it under a new id instead.
 *
 * Recordings are gitignored because they hold occupancy data. A floor plan is
 * a map of someone's home, which is the same category of information, so
 * `data/` is gitignored as a whole and plans live inside it.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_FLAT } from '../../public/js/lib/plans/default-flat.js';
import {
  validatePlan, sanitizePlan, planSizeMetres, blankPlan,
} from '../../public/js/lib/plan.js';

/** Built-in plans, by id. Read-only. */
const BUILTINS = new Map([
  [DEFAULT_FLAT.id, DEFAULT_FLAT],
]);

export const DEFAULT_PLAN_ID = DEFAULT_FLAT.id;

/** Ids that may never be written to disk, so a built-in cannot be shadowed. */
const RESERVED = new Set([...BUILTINS.keys()]);

export class PlanStore {
  constructor(config, log) {
    this.log = log('plans');
    this.dir = config.plans?.dir ?? path.join('data', 'plans');
    this.activeFile = path.join(this.dir, 'active.json');
    this.activeId = config.plans?.active ?? DEFAULT_PLAN_ID;
    this.cache = new Map();     // id -> plan (user plans only)
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    await this.#loadAll();

    // Restore the previously active plan. A server restart must not silently
    // revert the space to the built-in default — every node position and zone
    // would move, and nothing on screen would say why.
    try {
      const raw = await fsp.readFile(this.activeFile, 'utf8');
      const { active } = JSON.parse(raw);
      if (active && (BUILTINS.has(active) || this.cache.has(active))) {
        this.activeId = active;
      } else if (active) {
        this.log.warn(`active plan "${active}" no longer exists — falling back to ${DEFAULT_PLAN_ID}`);
      }
    } catch {
      // No active.json yet: first run, keep the default.
    }

    this.log.info(
      `${this.cache.size} saved plan(s), active "${this.activeId}" ` +
      `(${describeSize(this.get(this.activeId))})`,
    );
  }

  async #loadAll() {
    let files = [];
    try {
      files = await fsp.readdir(this.dir);
    } catch {
      return;
    }

    for (const f of files) {
      if (!f.endsWith('.json') || f === 'active.json') continue;
      const full = path.join(this.dir, f);
      try {
        const plan = JSON.parse(await fsp.readFile(full, 'utf8'));
        const { ok, errors } = validatePlan(plan);
        if (!ok) {
          // Refuse to load rather than repair. A plan with a NaN coordinate
          // would resize the sensing field to NaN and every likelihood in the
          // grid with it, producing a field that never peaks again and no
          // error anywhere to explain it.
          this.log.warn(`skipping ${f}: ${errors.join('; ')}`);
          continue;
        }
        this.cache.set(plan.id, plan);
      } catch (err) {
        this.log.warn(`skipping ${f}: ${err.message}`);
      }
    }
  }

  /** Every plan, built-ins first. */
  list() {
    const rows = [];
    for (const p of BUILTINS.values()) rows.push(this.#summary(p, true));
    for (const p of this.cache.values()) rows.push(this.#summary(p, false));
    return rows;
  }

  #summary(plan, builtin) {
    const size = planSizeMetres(plan);
    return {
      id: plan.id,
      name: plan.name,
      builtin,
      active: plan.id === this.activeId,
      rooms: plan.rooms?.length ?? 0,
      doors: plan.doors?.length ?? 0,
      nodes: plan.nodes?.length ?? 0,
      size_m: [size.width, size.depth, size.height],
    };
  }

  get(id) {
    return BUILTINS.get(id) ?? this.cache.get(id) ?? null;
  }

  isBuiltin(id) {
    return BUILTINS.has(id);
  }

  active() {
    // Never return null: a missing active plan would leave the field with no
    // geometry at all. Fall back to the built-in rather than to nothing.
    return this.get(this.activeId) ?? DEFAULT_FLAT;
  }

  /**
   * Persist a plan. Returns { plan, warnings }.
   * Throws on an invalid plan or an attempt to overwrite a built-in.
   */
  async save(input) {
    const { ok, errors, warnings } = validatePlan(input);
    if (!ok) {
      const err = new Error(errors.join('; '));
      err.code = 'INVALID_PLAN';
      err.errors = errors;
      throw err;
    }

    const plan = sanitizePlan(input);

    if (RESERVED.has(plan.id)) {
      const err = new Error(
        `"${plan.id}" is a built-in plan and cannot be overwritten — save it under a new id`,
      );
      err.code = 'BUILTIN_READONLY';
      throw err;
    }

    const file = this.#fileFor(plan.id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(plan, null, 2), 'utf8');

    this.cache.set(plan.id, plan);
    this.log.info(`saved plan "${plan.id}" (${describeSize(plan)})`);

    return { plan, warnings };
  }

  async remove(id) {
    if (RESERVED.has(id)) {
      const err = new Error(`"${id}" is a built-in plan and cannot be deleted`);
      err.code = 'BUILTIN_READONLY';
      throw err;
    }
    if (!this.cache.has(id)) return false;

    await fsp.rm(this.#fileFor(id), { force: true });
    this.cache.delete(id);

    // Deleting the active plan must leave a valid one active, or the field
    // loses its geometry on the next tick.
    if (this.activeId === id) await this.setActive(DEFAULT_PLAN_ID);
    this.log.info(`deleted plan "${id}"`);
    return true;
  }

  async setActive(id) {
    const plan = this.get(id);
    if (!plan) return null;

    this.activeId = id;
    await fsp.writeFile(this.activeFile, JSON.stringify({ active: id }, null, 2), 'utf8');
    this.log.info(`active plan -> "${id}" (${describeSize(plan)})`);
    return plan;
  }

  /**
   * Resolve an id to a path inside the store, refusing anything that escapes
   * it. `validatePlan` already restricts ids to letters, digits, dash and
   * underscore, so this cannot currently fire — it is here so that loosening
   * that pattern later cannot quietly turn into a path traversal.
   */
  #fileFor(id) {
    const file = path.resolve(this.dir, `${id}.json`);
    const root = path.resolve(this.dir);
    if (file !== path.join(root, `${id}.json`) || !file.startsWith(root + path.sep)) {
      throw new Error(`refusing to write outside the plan store: ${id}`);
    }
    return file;
  }
}

function describeSize(plan) {
  if (!plan) return 'no plan';
  const s = planSizeMetres(plan);
  return `${s.width}×${s.depth} m, ${plan.rooms?.length ?? 0} rooms`;
}

export { blankPlan };
