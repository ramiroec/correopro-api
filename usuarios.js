const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

module.exports = (db) => {
  // Helper para omitir campos sensibles en respuestas
  const omitirCamposSensibles = (usuario) => {
    const { password, gmail_password, ...usuarioSafe } = usuario;
    return usuarioSafe;
  };

  // Login
  router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    try {
      const result = await db.query(
        'SELECT * FROM usuarios WHERE username = $1', 
        [username]
      );
      
      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Usuario o clave inválidos' });
      }

      const usuario = result.rows[0];
      
      // Comparar contraseñas (asumiendo que están en texto plano por ahora)
      // En producción, deberías usar bcrypt.compare()
      if (password !== usuario.password) {
        return res.status(401).json({ error: 'Usuario o clave inválidos' });
      }

      res.json({ 
        ok: true, 
        usuario: omitirCamposSensibles(usuario) 
      });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Error al validar usuario' });
    }
  });

  // Listar todos los usuarios (sin información sensible)
  router.get('/', async (req, res) => {
    try {
      const result = await db.query(
        `SELECT id, username, gmail_email, gmail_smtp_server, 
                gmail_smtp_port, gmail_ssl_enabled 
         FROM usuarios ORDER BY id`
      );
      res.json(result.rows);
    } catch (error) {
      console.error('Error al obtener usuarios:', error);
      res.status(500).json({ error: 'Error al obtener usuarios' });
    }
  });

  // Obtener usuario por id
  router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const result = await db.query(
        `SELECT id, username, gmail_email, gmail_smtp_server, 
                gmail_smtp_port, gmail_ssl_enabled 
         FROM usuarios WHERE id = $1`, 
        [id]
      );
      
      if (result.rows.length) {
        return res.json(result.rows[0]);
      }
      return res.status(404).json({ error: 'Usuario no encontrado' });
    } catch (error) {
      console.error('Error al obtener usuario:', error);
      res.status(500).json({ error: 'Error al obtener usuario' });
    }
  });

  // Crear nuevo usuario
  router.post('/', async (req, res) => {
    const { 
      username, 
      password, 
      gmail_email, 
      gmail_password, 
      gmail_smtp_server = 'smtp.gmail.com',
      gmail_smtp_port = 587,
      gmail_ssl_enabled = true
    } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username y password son requeridos' });
    }

    try {
      const result = await db.query(
        `INSERT INTO usuarios 
         (username, password, gmail_email, gmail_password, gmail_smtp_server, gmail_smtp_port, gmail_ssl_enabled) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         RETURNING id, username, gmail_email, gmail_smtp_server, gmail_smtp_port, gmail_ssl_enabled`,
        [username, password, gmail_email, gmail_password, gmail_smtp_server, gmail_smtp_port, gmail_ssl_enabled]
      );
      
      res.status(201).json(result.rows[0]);
    } catch (error) {
      console.error('Error al crear usuario:', error);
      if (error.code === '23505') {
        return res.status(409).json({ error: 'El usuario ya existe' });
      }
      res.status(500).json({ error: 'Error al crear usuario' });
    }
  });

  // Actualizar usuario completo
  router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { 
      username, 
      password, 
      gmail_email, 
      gmail_password, 
      gmail_smtp_server,
      gmail_smtp_port,
      gmail_ssl_enabled
    } = req.body;

    if (!username) {
      return res.status(400).json({ error: 'Username es requerido' });
    }

    try {
      // Construir query dinámicamente para actualizar solo los campos proporcionados
      let query = 'UPDATE usuarios SET username = $1';
      const values = [username, id];
      let paramIndex = 3;

      if (password) {
        query += `, password = $${paramIndex}`;
        values.splice(paramIndex - 1, 0, password);
        paramIndex++;
      }

      if (gmail_email !== undefined) {
        query += `, gmail_email = $${paramIndex}`;
        values.splice(paramIndex - 1, 0, gmail_email);
        paramIndex++;
      }

      if (gmail_password !== undefined) {
        query += `, gmail_password = $${paramIndex}`;
        values.splice(paramIndex - 1, 0, gmail_password);
        paramIndex++;
      }

      if (gmail_smtp_server !== undefined) {
        query += `, gmail_smtp_server = $${paramIndex}`;
        values.splice(paramIndex - 1, 0, gmail_smtp_server);
        paramIndex++;
      }

      if (gmail_smtp_port !== undefined) {
        query += `, gmail_smtp_port = $${paramIndex}`;
        values.splice(paramIndex - 1, 0, gmail_smtp_port);
        paramIndex++;
      }

      if (gmail_ssl_enabled !== undefined) {
        query += `, gmail_ssl_enabled = $${paramIndex}`;
        values.splice(paramIndex - 1, 0, gmail_ssl_enabled);
        paramIndex++;
      }

      query += ` WHERE id = $2 
                RETURNING id, username, gmail_email, gmail_smtp_server, gmail_smtp_port, gmail_ssl_enabled`;

      const result = await db.query(query, values);

      if (result.rows.length) {
        return res.json(result.rows[0]);
      }
      return res.status(404).json({ error: 'Usuario no encontrado' });
    } catch (error) {
      console.error('Error al actualizar usuario:', error);
      if (error.code === '23505') {
        return res.status(409).json({ error: 'El usuario ya existe' });
      }
      res.status(500).json({ error: 'Error al actualizar usuario' });
    }
  });

  // Actualizar solo la configuración de Gmail
  router.put('/:id/gmail-config', async (req, res) => {
    const { id } = req.params;
    const { 
      gmail_email, 
      gmail_password, 
      gmail_smtp_server = 'smtp.gmail.com',
      gmail_smtp_port = 587,
      gmail_ssl_enabled = true
    } = req.body;

    if (!gmail_email || !gmail_password) {
      return res.status(400).json({ error: 'Gmail email y password son requeridos' });
    }

    try {
      const result = await db.query(
        `UPDATE usuarios 
         SET gmail_email = $1, gmail_password = $2, gmail_smtp_server = $3, 
             gmail_smtp_port = $4, gmail_ssl_enabled = $5
         WHERE id = $6 
         RETURNING id, username, gmail_email, gmail_smtp_server, gmail_smtp_port, gmail_ssl_enabled`,
        [gmail_email, gmail_password, gmail_smtp_server, gmail_smtp_port, gmail_ssl_enabled, id]
      );

      if (result.rows.length) {
        return res.json(result.rows[0]);
      }
      return res.status(404).json({ error: 'Usuario no encontrado' });
    } catch (error) {
      console.error('Error al actualizar configuración Gmail:', error);
      res.status(500).json({ error: 'Error al actualizar configuración Gmail' });
    }
  });

  // Eliminar usuario
  router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const result = await db.query('DELETE FROM usuarios WHERE id = $1 RETURNING id', [id]);
      
      if (result.rows.length) {
        return res.status(204).end();
      }
      return res.status(404).json({ error: 'Usuario no encontrado' });
    } catch (error) {
      console.error('Error al eliminar usuario:', error);
      res.status(500).json({ error: 'Error al eliminar usuario' });
    }
  });

  return router;
};