const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_p1VnHXNqD0wF@ep-soft-fog-acbz2sa5-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  ssl: { rejectUnauthorized: false },
  idleTimeoutMillis: 60000, // 1 minuto
  connectionTimeoutMillis: 5000, // 5 segundos para conectar
  max: 5 // Solo 5 conexiones simultáneas
});

module.exports = {
  async query(text, params) {
    const client = await pool.connect();
    try {
      const result = await client.query(text, params);
      return result;
    } finally {
      client.release();
    }
  }
};