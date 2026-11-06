/**
 * Creates (or resets) the platform-operator account: role admin + the
 * is_platform_admin flag that the /admin console requires (adminAuth.js).
 *
 * Usage (inside the backend container):
 *   docker compose exec -e ADMIN_EMAIL=ops@example.com -e ADMIN_PASSWORD='S0me-strong-pass' \
 *     smart-cam-backend node scripts/create-admin.js
 *
 * Re-running with the same e-mail resets that account's password.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const { Sequelize } = require('sequelize');

const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || '';
const name = process.env.ADMIN_NAME || 'Platform Admin';

if (!email || password.length < 10) {
  console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 10 characters).');
  process.exit(1);
}

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    logging: false,
  }
);

async function main() {
  await sequelize.authenticate();

  const hashed = await bcrypt.hash(password, 12);

  await sequelize.query(
    `INSERT INTO users (id, name, email, password, role, is_active, email_verified,
                        is_platform_admin, created_at, updated_at)
     VALUES (UUID(), ?, ?, ?, 'admin', 1, 1, 1, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       password = VALUES(password),
       role = 'admin',
       is_active = 1,
       is_platform_admin = 1`,
    { replacements: [name, email, hashed] }
  );

  console.log(`Admin user ready: ${email} (platform operator). Sign in at /login; operator console at /admin.`);

  await sequelize.close();
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
