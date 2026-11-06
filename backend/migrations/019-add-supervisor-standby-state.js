'use strict';

/**
 * Adds 'standby' to the cameras.supervisor_state ENUM.
 *
 * 'standby' = the camera's host is reachable (per the cameraReachability
 * prober) but its sourceOnDemand path isn't currently being pulled, so MediaMTX
 * never reports ready=true. This is a HEALTHY, public-online state — without it
 * every idle on-demand camera looked offline, and the supervisor's attempt to
 * persist supervisor_state='standby' failed with "Data truncated for column".
 *
 * Idempotent: only widens the ENUM if 'standby' isn't already present.
 */

const ENUM_WITH_STANDBY =
  "ENUM('pending','connecting','streaming','degraded','offline','quarantined','standby')";
const ENUM_WITHOUT =
  "ENUM('pending','connecting','streaming','degraded','offline','quarantined')";

async function supervisorStateType(queryInterface) {
  const [rows] = await queryInterface.sequelize.query(
    "SHOW COLUMNS FROM cameras LIKE 'supervisor_state'",
  );
  return rows && rows[0] ? rows[0].Type : null;
}

module.exports = {
  async up(queryInterface) {
    const type = await supervisorStateType(queryInterface);
    if (!type || type.includes("'standby'")) return; // already widened or column missing
    await queryInterface.sequelize.query(
      `ALTER TABLE cameras MODIFY COLUMN supervisor_state ${ENUM_WITH_STANDBY} NULL`,
    );
  },

  async down(queryInterface) {
    // Collapse any standby rows back to offline before narrowing the ENUM,
    // otherwise the MODIFY would truncate them.
    await queryInterface.sequelize.query(
      "UPDATE cameras SET supervisor_state='offline' WHERE supervisor_state='standby'",
    ).catch(() => {});
    await queryInterface.sequelize.query(
      `ALTER TABLE cameras MODIFY COLUMN supervisor_state ${ENUM_WITHOUT} NULL`,
    ).catch(() => {});
  },
};
