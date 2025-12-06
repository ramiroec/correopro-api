const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

module.exports = function(db) {
  const express = require('express');
  const router = express.Router();

  // Función para generar HTML con pixel de tracking
  const generarHTMLConTracking = (cuerpo, envioId, correoId, trackingToken) => {
    const pixelUrl = `https://vps-aff6ee56.vps.ovh.ca/correo-api/correos/track/${trackingToken}`;
    
    return `
      <div style="font-family: Arial, sans-serif; background: #f9f9f9; padding: 32px;">
        <div style="max-width: 600px; margin: auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 8px #eee; padding: 24px;">
          <div>${cuerpo}</div>
          <hr style="margin: 32px 0;">
          <!-- Pixel de tracking invisible -->
          <img src="${pixelUrl}" width="1" height="1" style="display:none" alt="tracking" />
          <div style="text-align: center; color: #888; font-size: 11px;">
            <img src="https://cdn-icons-png.flaticon.com/512/561/561127.png" alt="Correo" width="24" style="margin-bottom: 4px;" />
            <br>
            Este correo forma parte de una comunicación masiva enviada con fines informativos.
          </div>
        </div>
      </div>
    `;
  };

  // Endpoint para tracking de aperturas
  router.get('/track/:token', async (req, res) => {
    const { token } = req.params;
    
    try {
      // Registrar la apertura
      await db.query(
        `INSERT INTO tracking_aperturas (envio_id, correo_id, fecha_apertura, ip_address, user_agent)
         SELECT ed.envio_id, ed.correo_id, CURRENT_TIMESTAMP, $1, $2
         FROM envios_detalle ed
         WHERE ed.tracking_token = $3`,
        [req.ip, req.get('User-Agent'), token]
      );

      // Actualizar contador de aperturas en el envío
      await db.query(
        `UPDATE envios 
         SET correos_abiertos = (
           SELECT COUNT(DISTINCT correo_id) 
           FROM tracking_aperturas 
           WHERE envio_id = envios.id
         )
         WHERE id = (SELECT envio_id FROM envios_detalle WHERE tracking_token = $1)`,
        [token]
      );

      // Devolver un pixel transparente 1x1
      res.setHeader('Content-Type', 'image/png');
      res.send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
    } catch (error) {
      console.error('Error en tracking:', error);
      // De todas formas devolver el pixel
      res.setHeader('Content-Type', 'image/png');
      res.send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
    }
  });

  // Nuevo endpoint: cantidad de contactos en una lista
  router.get('/lista/:id/count', async (req, res) => {
    const { id } = req.params;
    try {
      const result = await db.query(
        `SELECT COUNT(*) as count
         FROM correos c
         JOIN correos_listas cl ON c.id = cl.correo_id
         WHERE cl.lista_id = $1`,
        [id]
      );
      res.json({ count: parseInt(result.rows[0].count) || 0 });
    } catch (err) {
      console.error('❌ Error al obtener count de lista:', err.message);
      res.status(500).json({ error: 'Error al obtener count de lista.' });
    }
  });

  // Enviar correos con configuración de usuario y tracking
  router.post('/enviar', async (req, res) => {
    const { asunto, cuerpo, listaId, adjuntos, usuarioId, usuarioIds } = req.body;
    
    if (!listaId || (!usuarioId && (!Array.isArray(usuarioIds) || usuarioIds.length === 0))) {
      return res.status(400).json({ error: 'Debe indicar listaId y al menos un usuario remitente' });
    }

    console.log('📨 Enviando email con asunto:', asunto, 'a lista:', listaId, 'usuario(s):', usuarioId || usuarioIds);

    const inicio = Date.now();
    let transporter = null;
    let envioId = null;

    try {
      // Obtener remitentes: soportar usuarioId legacy o usuarioIds array
      const remitentes = usuarioId ? [usuarioId] : (Array.isArray(usuarioIds) ? usuarioIds : []);

      // Obtener los correos de la lista indicada
      const correosResult = await db.query(
        `SELECT c.id, c.email
         FROM correos c
         JOIN correos_listas cl ON c.id = cl.correo_id
         WHERE cl.lista_id = $1`,
        [listaId]
      );

      const allCorreos = correosResult.rows;
      console.log('📬 Total de correos en la lista:', allCorreos.length);

      if (allCorreos.length === 0) {
        return res.status(400).json({ error: 'La lista no tiene correos.' });
      }

      // Control: máximo 400 por remitente
      const maxPerSender = 400;
      if (remitentes.length * maxPerSender < allCorreos.length) {
        const needed = Math.ceil(allCorreos.length / maxPerSender);
        return res.status(400).json({ error: `La lista tiene ${allCorreos.length} contactos. Necesitás al menos ${needed} remitentes (máx ${maxPerSender} correos por remitente).` });
      }

      // Crear registro de envío
      const envioResult = await db.query(
        `INSERT INTO envios 
         (fecha, asunto, cuerpo, usuario_id, lista_id, total_correos, estado) 
         VALUES ($1, $2, $3, $4, $5, $6, 'enviando')
         RETURNING id`,
        [new Date().toISOString(), asunto, cuerpo, remitentes[0], listaId, allCorreos.length]
      );

      envioId = envioResult.rows[0].id;

      const batchSize = 50;
      let lotes = 0;
      let correosEnviados = 0;
      let correosRebotados = 0;

      // Repartir destinatarios por remitente: bloques de hasta maxPerSender por remitente en orden
      const groups = remitentes.map((r, idx) => {
        const start = idx * maxPerSender;
        return allCorreos.slice(start, start + maxPerSender);
      });

      // Si hay más remitentes de los necesarios, también cubrirá los primeros bloques; pero el check anterior asegura cobertura

      // Procesar por cada remitente su grupo
      for (let ri = 0; ri < remitentes.length; ri++) {
        const senderId = remitentes[ri];
        const group = groups[ri] || [];
        if (!group || group.length === 0) continue;

        // obtener datos del remitente
        const usuarioResult = await db.query('SELECT * FROM usuarios WHERE id = $1', [senderId]);
        if (usuarioResult.rows.length === 0) {
          console.warn(`⚠️ Remitente ${senderId} no encontrado, se saltea su grupo`);
          continue;
        }
        const usuario = usuarioResult.rows[0];
        if (!usuario.gmail_email || !usuario.gmail_password) {
          console.warn(`⚠️ Remitente ${senderId} sin Gmail configurado, se saltea su grupo`);
          continue;
        }

        // crear transporter específico por remitente
        const senderTransporter = require('nodemailer').createTransport({
          service: 'gmail',
          auth: {
            user: usuario.gmail_email,
            pass: usuario.gmail_password
          },
          pool: true,
          maxConnections: 5,
          maxMessages: 100,
          rateLimit: 10,
          rateDelta: 1000
        });
        await senderTransporter.verify();

        // Enviar la porción del remitente en lotes más pequeños (batchSize)
        for (let i = 0; i < group.length; i += batchSize) {
          const batch = group.slice(i, i + batchSize);
          lotes++;
          console.log(`✉️ Remitente ${usuario.gmail_email} - enviando lote ${lotes} a ${batch.length} destinatarios`);

          // Procesar adjuntos (descargar una vez por lote)
          let attachments = [];
          if (Array.isArray(adjuntos) && adjuntos.length > 0) {
            attachments = await Promise.all(adjuntos.map(async (adj) => {
              const url = typeof adj === 'string' ? adj : adj.url;
              const name = typeof adj === 'string' ? undefined : adj.name;
              const response = await axios.get(url, { responseType: 'arraybuffer' });
              let filename = name;
              if (!filename) {
                const urlParts = url.split('/');
                filename = urlParts[urlParts.length - 1].split('?')[0];
              }
              let contentType = response.headers['content-type'] || 'application/octet-stream';
              return {
                filename,
                content: Buffer.from(response.data, 'binary'),
                contentType,
              };
            }));
          }

          for (const correo of batch) {
            const trackingToken = uuidv4();
            try {
              const mailOptions = {
                from: usuario.gmail_email,
                to: correo.email,
                subject: asunto,
                html: generarHTMLConTracking(cuerpo, envioId, correo.id, trackingToken),
                attachments
              };
              await senderTransporter.sendMail(mailOptions);
              correosEnviados++;
              await db.query(
                `INSERT INTO envios_detalle 
                 (envio_id, correo_id, fecha_envio, estado, tracking_token) 
                 VALUES ($1, $2, $3, 'enviado', $4)`,
                [envioId, correo.id, new Date().toISOString(), trackingToken]
              );
            } catch (error) {
              console.error(`❌ Error enviando a ${correo.email} con remitente ${usuario.gmail_email}:`, error.message);
              correosRebotados++;
              await db.query(
                `INSERT INTO envios_detalle 
                 (envio_id, correo_id, fecha_envio, estado, mensaje_error) 
                 VALUES ($1, $2, $3, 'rebotado', $4)`,
                [envioId, correo.id, new Date().toISOString(), error.message]
              );
              if (error.responseCode && error.responseCode >= 400) {
                await db.query(
                  `INSERT INTO correos_rebotados 
                   (envio_id, correo_id, fecha_rebote, motivo_rebote, codigo_error) 
                   VALUES ($1, $2, $3, $4, $5)`,
                  [envioId, correo.id, new Date().toISOString(), error.message, error.responseCode.toString()]
                );
              }
            }
          }
          // pequeña pausa entre lotes para evitar rate limiting
          if (i + batchSize < group.length) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        // cerrar transporter del remitente si tiene método close
        if (senderTransporter && typeof senderTransporter.close === 'function') {
          try { senderTransporter.close() } catch (e) {}
        }
      }

      // Actualizar estado final del envío
      await db.query(
        `UPDATE envios 
         SET estado = 'completado', 
             fecha_fin = $1,
             correos_enviados = $2,
             correos_rebotados = $3
         WHERE id = $4`,
        [new Date().toISOString(), correosEnviados, correosRebotados, envioId]
      );

      const fin = Date.now();

      res.json({
        mensaje: `Correo enviado a ${correosEnviados} destinatarios (${correosRebotados} rebotados)`,
        asunto,
        listaId,
        usuarioIds: remitentes,
        totalDestinatarios: allCorreos.length,
        correosEnviados,
        correosRebotados,
        lotes,
        envioId,
        fecha: new Date().toISOString(),
        duracionSegundos: Math.round((fin - inicio) / 1000)
      });

    } catch (err) {
      console.error('❌ Error general al enviar correo:', err.message);

      // Si hay un envioId, marcar como error
      if (envioId) {
        await db.query(
          'UPDATE envios SET estado = $1, error_message = $2 WHERE id = $3',
          ['error', err.message, envioId]
        );
      }

      res.status(500).json({ 
        error: 'Error al enviar correo.',
        detalles: err.message 
      });
    }
  });

  // Ver historial de envíos con información completa
  router.get('/envios', async (req, res) => {
    try {
      const result = await db.query(
        `SELECT e.*, u.username, l.nombre as lista_nombre
         FROM envios e
         LEFT JOIN usuarios u ON e.usuario_id = u.id
         LEFT JOIN listas l ON e.lista_id = l.id
         ORDER BY e.fecha DESC LIMIT 12`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Error al obtener envíos:', err.message);
      res.status(500).json({ error: 'Error al obtener envíos.' });
    }
  });

  // Obtener detalles de un envío específico
  router.get('/envios/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
      const envioResult = await db.query(
        `SELECT e.*, u.username, l.nombre as lista_nombre
         FROM envios e
         LEFT JOIN usuarios u ON e.usuario_id = u.id
         LEFT JOIN listas l ON e.lista_id = l.id
         WHERE e.id = $1`,
        [id]
      );

      if (envioResult.rows.length === 0) {
        return res.status(404).json({ error: 'Envío no encontrado' });
      }

      const detallesResult = await db.query(
        `SELECT ed.*, c.email, 
                EXISTS(SELECT 1 FROM tracking_aperturas ta WHERE ta.correo_id = ed.correo_id AND ta.envio_id = ed.envio_id) as abierto,
                EXISTS(SELECT 1 FROM correos_rebotados cr WHERE cr.correo_id = ed.correo_id AND cr.envio_id = ed.envio_id) as rebotado
         FROM envios_detalle ed
         JOIN correos c ON ed.correo_id = c.id
         WHERE ed.envio_id = $1
         ORDER BY ed.fecha_envio DESC`,
        [id]
      );

      const aperturasResult = await db.query(
        `SELECT COUNT(*) as total_aperturas
         FROM tracking_aperturas 
         WHERE envio_id = $1`,
        [id]
      );

      res.json({
        envio: envioResult.rows[0],
        detalles: detallesResult.rows,
        metricas: {
          total_aperturas: parseInt(aperturasResult.rows[0].total_aperturas) || 0
        }
      });

    } catch (err) {
      console.error('❌ Error al obtener detalles del envío:', err.message);
      res.status(500).json({ error: 'Error al obtener detalles del envío.' });
    }
  });

  // Nuevo: Obtener todos los correos (para "Total de contactos" en el dashboard)
  router.get('/', async (req, res) => {
    try {
      const result = await db.query('SELECT id, email FROM correos ORDER BY email');
      res.json(result.rows);
    } catch (err) {
      console.error('❌ Error al obtener correos:', err.message);
      res.status(500).json({ error: 'Error al obtener correos.' });
    }
  });

  // Estadísticas de envíos (mantener ya existente)
  router.get('/estadisticas', async (req, res) => {
    try {
      const estadisticas = await db.query(
        `SELECT 
           COUNT(*) as total_envios,
           SUM(total_correos) as total_correos_enviados,
           SUM(correos_enviados) as correos_entregados,
           SUM(correos_rebotados) as correos_rebotados,
           SUM(correos_abiertos) as correos_abiertos,
           AVG(correos_abiertos::float / NULLIF(correos_enviados, 0)) * 100 as tasa_apertura_avg
         FROM envios 
         WHERE estado = 'completado'`
      );

      const recientes = await db.query(
        `SELECT fecha, asunto, correos_enviados, correos_abiertos
         FROM envios 
         WHERE estado = 'completado'
         ORDER BY fecha DESC 
         LIMIT 5`
      );

      res.json({
        general: estadisticas.rows[0],
        recientes: recientes.rows
      });
    } catch (err) {
      console.error('❌ Error al obtener estadísticas:', err.message);
      res.status(500).json({ error: 'Error al obtener estadísticas.' });
    }
  });

  // Modificado: Obtener envíos recientes soportando ?limit=N y añadiendo tasa_apertura + usuario
  router.get('/envios', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 12;

      const result = await db.query(
        `SELECT e.id, e.fecha, e.asunto, e.correos_enviados, e.correos_abiertos, e.estado,
                u.username AS usuario, l.nombre as lista_nombre
         FROM envios e
         LEFT JOIN usuarios u ON e.usuario_id = u.id
         LEFT JOIN listas l ON e.lista_id = l.id
         ORDER BY e.fecha DESC
         LIMIT $1`,
        [limit]
      );

      const envios = result.rows.map((r) => {
        const enviados = parseInt(r.correos_enviados) || 0;
        const abiertos = parseInt(r.correos_abiertos) || 0;
        const tasa_apertura = enviados === 0 ? 0 : Math.round((abiertos / enviados) * 100);
        return {
          id: r.id,
          fecha: r.fecha,
          asunto: r.asunto,
          correos_enviados: enviados,
          correos_abiertos: abiertos,
          tasa_apertura,
          usuario: r.usuario || 'Sistema',
          lista_nombre: r.lista_nombre,
          estado: r.estado
        };
      });

      res.json(envios);
    } catch (err) {
      console.error('❌ Error al obtener envíos:', err.message);
      res.status(500).json({ error: 'Error al obtener envíos.' });
    }
  });

  return router;
};