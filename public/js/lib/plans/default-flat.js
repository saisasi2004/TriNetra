/**
 * The built-in default plan.
 *
 * This is a real two-bedroom flat, and it ships as the default because a
 * sensing demo against a plausible dwelling tells you far more than one
 * against an empty 6×5 box: rooms of different sizes, attached bathrooms,
 * balconies, and interior walls the radio actually has to see through.
 *
 * It is READ-ONLY in the planner. Editing it in place would mean the one
 * layout everybody starts from drifts per-install and stops being a shared
 * reference; the planner duplicates it instead, which costs one click and
 * keeps the original intact.
 *
 * Rooms are declared in FEET (matching the dimensions printed on an
 * architectural plan) with the origin at the plan's top-left corner —
 * x runs left→right, z runs top→bottom, as you read the drawing.
 *
 * Dimensions come from the plan's printed sizes; positions are inferred from
 * their arrangement, so a wall may be off by a few inches. Nudge the
 * x0/z0/x1/z1 numbers to match a tape measure — nothing else needs changing.
 */

export const DEFAULT_FLAT = {
  id: 'default-flat',
  name: 'Default flat',
  units: 'ft',
  wall_height_m: 3.05,

  rooms: [
    { id: 'bed1', label: 'BED ROOM', type: 'room', dim: "11'0\" × 15'0\"", x0: 0, z0: 0, x1: 11, z1: 15 },

    // Printed 14'4" deep, drawn to 15 so it meets BED ROOM 1 and DINING on a
    // shared wall. A 7-inch discrepancy is well inside the accuracy of
    // positions inferred from a photo, and a clean junction matters more —
    // rooms separated by a sliver produce doorways that open onto nothing.
    { id: 'hall', label: 'HALL', type: 'room', dim: "15'4\" × 14'4\"", x0: 11, z0: 0, x1: 26.4, z1: 15 },

    // TOILET 1 sits directly below BED ROOM 1 and TOILET 2 directly above
    // BED ROOM 2, because each is an attached bathroom — they must SHARE a
    // wall with their bedroom or the door has nowhere to go. That constraint
    // is what sets the depth of the DINING band between them.
    { id: 'toilet1', label: 'TOILET', type: 'wet', dim: "7'7\" × 4'8\"", x0: 0, z0: 15, x1: 7.6, z1: 19.7 },
    { id: 'toilet2', label: 'TOILET', type: 'wet', dim: "7'7\" × 4'8\"", x0: 0, z0: 19.7, x1: 7.6, z1: 24.4 },

    // The printed 11'4" square is the dining area proper. On the drawing the
    // open space runs from the toilet wall out to the balcony partition and
    // down to BED ROOM 2, so it is modelled to the walls — walls are what the
    // radio actually sees, and the label still carries the printed size.
    { id: 'dining', label: 'DINING', type: 'room', dim: "11'4\" × 11'4\"", x0: 7.6, z0: 15, x1: 22.4, z1: 24.4 },

    { id: 'balc1', label: 'BALCONY', type: 'balcony', dim: "4'0\"", x0: 22.4, z0: 15, x1: 26.4, z1: 24.4 },
    { id: 'kitchen', label: 'KITCHEN', type: 'wet', dim: "11'0\" × 7'3\"", x0: 15.4, z0: 24.4, x1: 26.4, z1: 31.65 },
    { id: 'bed2', label: 'BED ROOM', type: 'room', dim: "15'4\" × 11'3\"", x0: 0, z0: 24.4, x1: 15.4, z1: 35.65 },
    { id: 'balc2', label: 'BALCONY', type: 'balcony', dim: "4'0\"", x0: 15.4, z0: 31.65, x1: 26.4, z1: 35.65 },
  ],

  /**
   * Doorways — the places the plan has NO red line.
   *
   * Each entry punches a gap through every wall that passes through it, so a
   * single door opens both adjoining rooms automatically. No door leaf is
   * drawn; the opening is the opening.
   *
   *   x, z  centre of the opening, in feet from the plan's top-left
   *   w     clear width in feet
   *   dir   'h' = gap in a wall running left-right (a horizontal wall)
   *         'v' = gap in a wall running top-bottom (a vertical wall)
   *
   * Standard door 3'0", toilet 2'6", archways and balcony openings wider.
   */
  doors: [
    // Main entry. The plan breaks the top wall at its right-hand end.
    { id: 'entrance', x: 24.5, z: 0, w: 3.0, dir: 'h' },

    // BED ROOM 1 does NOT open into the HALL — the wall between them runs
    // unbroken from the top wall down. Its door is the gap at the right-hand
    // end of its BOTTOM wall, opening south into the dining/passage.
    { id: 'bed1-dining', x: 9.3, z: 15.0, w: 3.0, dir: 'h' },

    // HALL to DINING is the wide break in the hall's bottom wall — an
    // archway, not a door.
    { id: 'hall-dining', x: 15.0, z: 15.0, w: 6.0, dir: 'h' },

    // Attached bathrooms: each toilet opens into ITS OWN bedroom, never into
    // the dining area. TOILET 1 through its top wall into BED ROOM 1,
    // TOILET 2 through its bottom wall into BED ROOM 2.
    { id: 'toilet1-bed1', x: 3.8, z: 15.0, w: 2.4, dir: 'h' },
    { id: 'toilet2-bed2', x: 3.8, z: 24.4, w: 2.4, dir: 'h' },

    { id: 'dining-bed2', x: 11.0, z: 24.4, w: 3.5, dir: 'h' },
    { id: 'dining-kitchen', x: 18.0, z: 24.4, w: 3.0, dir: 'h' },
    { id: 'dining-balc1', x: 22.4, z: 20.0, w: 5.0, dir: 'v' },
    { id: 'kitchen-balc2', x: 21.0, z: 31.65, w: 5.0, dir: 'h' },
  ],

  /**
   * Where the three sensing nodes hang.
   *
   * Spread across three DIFFERENT walls so their triangle contains the middle
   * of the flat. That ordering is not cosmetic: it is the arrangement that
   * measured best in the layout study documented in engine.js — clustering
   * nodes on two adjacent walls leaves the far side outside their triangle,
   * where range circles meet at shallow angles and a small range error swings
   * the fix a long way. Placement matters more than node count.
   *
   * Three, because three is the smallest array that can multilaterate at all.
   */
  nodes: [
    { node_id: 1, x: 18.7, z: 0.8, height_m: 1.2 },    // HALL, top wall
    { node_id: 2, x: 8.4, z: 19.7, height_m: 1.2 },    // DINING, left wall
    { node_id: 3, x: 7.7, z: 34.8, height_m: 1.2 },    // BED ROOM 2, bottom wall
  ],
};
