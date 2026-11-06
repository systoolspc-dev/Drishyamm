'use strict';

const CHAR36 = 'CHAR(36) BINARY';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('mediamtx_servers')) return;

    // Pool of MediaMTX instances. The router picks one when a camera is created.
    // This lets us scale past ~500 cameras (single-instance practical limit)
    // by adding more servers — each tied to a site, ideally co-located with
    // the cameras to keep RTSP traffic on the LAN.
    await queryInterface.createTable('mediamtx_servers', {
      id: {
        type: CHAR36,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      site_id: {
        type: CHAR36,
        allowNull: true,                    // null = central / default pool
        references: { model: 'sites', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      name: { type: Sequelize.STRING(120), allowNull: false },
      // Human-meaningful hostname for ops dashboards
      hostname: { type: Sequelize.STRING(255), allowNull: false },
      // Internal control-plane URL — what our backend calls
      api_url: { type: Sequelize.STRING(255), allowNull: false },
      api_user: { type: Sequelize.STRING(120), allowNull: true },
      api_pass: { type: Sequelize.STRING(255), allowNull: true },
      // Public URLs the BROWSER hits (HLS via NGINX, WebRTC via TURN if any)
      hls_url: { type: Sequelize.STRING(255), allowNull: false },
      webrtc_url: { type: Sequelize.STRING(255), allowNull: false },
      // Internal RTSP egress — used only by the AI worker
      rtsp_internal_host: { type: Sequelize.STRING(255), allowNull: false },
      rtsp_internal_port: { type: Sequelize.INTEGER, defaultValue: 8554 },
      // Capacity planning
      capacity_cams: { type: Sequelize.INTEGER, defaultValue: 200 },
      current_cams:  { type: Sequelize.INTEGER, defaultValue: 0 },
      // Liveness
      status: {
        type: Sequelize.ENUM('online', 'offline', 'draining'),
        defaultValue: 'online',
      },
      last_heartbeat: { type: Sequelize.DATE, allowNull: true },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    }, {
      charset: 'utf8mb4',
      collate: 'utf8mb4_unicode_ci',
    });

    await queryInterface.addIndex('mediamtx_servers', ['site_id']).catch(() => {});
    await queryInterface.addIndex('mediamtx_servers', ['status']).catch(() => {});

    // Seed a row from the existing env vars so the router always has a
    // default to fall back to. The router treats site_id=NULL as the
    // global pool that any site can use when no site-specific server exists.
    const envHls   = process.env.MEDIAMTX_HLS_URL    || 'http://localhost:8888';
    const envWrtc  = process.env.MEDIAMTX_WEBRTC_URL || 'http://localhost:8889';
    const envApi   = process.env.MEDIAMTX_API_URL    || 'http://localhost:9997';
    const envUser  = process.env.MEDIAMTX_API_USER   || 'drishyam';
    const envPass  = process.env.MEDIAMTX_API_PASS   || 'drishyam123';
    const envRHost = process.env.MEDIAMTX_RTSP_HOST  || 'localhost';
    const envRPort = parseInt(process.env.MEDIAMTX_RTSP_PORT, 10) || 8554;

    await queryInterface.bulkInsert('mediamtx_servers', [{
      id:              Sequelize.literal('(UUID())'),
      site_id:         null,
      name:            'default',
      hostname:        'localhost',
      api_url:         envApi,
      api_user:        envUser,
      api_pass:        envPass,
      hls_url:         envHls,
      webrtc_url:      envWrtc,
      rtsp_internal_host: envRHost,
      rtsp_internal_port: envRPort,
      capacity_cams:   500,
      current_cams:    0,
      status:          'online',
      created_at:      new Date(),
      updated_at:      new Date(),
    }]).catch((e) => {
      console.warn('mediamtx_servers seed failed (non-fatal):', e.message);
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('mediamtx_servers').catch(() => {});
  },
};
