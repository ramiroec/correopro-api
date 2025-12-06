module.exports = function (db, transporter) {
    const express = require('express');
    const router = express.Router();
    const dns = require('dns').promises;

    // Crear una nueva lista
    router.post('/', async (req, res) => {
        const { nombre } = req.body;
        try {
            await db.query('INSERT INTO listas (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING', [nombre]);
            res.send('Lista creada.');
        } catch (err) {
            console.error('❌ Error al crear lista:', err.message);
            res.status(500).send('Error al crear lista.');
        }
    });

    // Listar todas las listas
    router.get('/', async (req, res) => {
        try {
            const result = await db.query('SELECT * FROM listas ORDER BY nombre');
            res.json(result.rows);
        } catch (err) {
            console.error('❌ Error al obtener listas:', err.message);
            res.status(500).send('Error al obtener listas.');
        }
    });

    // Agregar un correo a una lista
    router.post('/:id/correos', async (req, res) => {
        const { email } = req.body;
        const listaId = req.params.id;

        try {
            const correoRes = await db.query('INSERT INTO correos (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id', [email]);
            const correoId = correoRes.rows[0].id;

            await db.query('INSERT INTO correos_listas (correo_id, lista_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [correoId, listaId]);
            res.send('Correo agregado a la lista.');
        } catch (err) {
            console.error('❌ Error al agregar correo a lista:', err.message);
            res.status(500).send('Error al asociar correo a lista.');
        }
    });

    // Obtener todos los correos de una lista
    router.get('/:id/correos', async (req, res) => {
        const listaId = req.params.id;
        try {
            const result = await db.query(`
      SELECT c.id, c.email
      FROM correos c
      JOIN correos_listas cl ON c.id = cl.correo_id
      WHERE cl.lista_id = $1
      ORDER BY c.email
    `, [listaId]);

            res.json(result.rows);
        } catch (err) {
            console.error('❌ Error al obtener correos de lista:', err.message);
            res.status(500).send('Error al obtener correos de la lista.');
        }
    });

    // Enviar a varias listas (evitar duplicados)
    router.post('/enviar', async (req, res) => {
        const { asunto, cuerpo, listas } = req.body;
        console.log('📨 Enviando email con asunto:', asunto);

        try {
            let result;

            if (listas && listas.length > 0) {
                result = await db.query(`
        SELECT DISTINCT c.email
        FROM correos c
        JOIN correos_listas cl ON c.id = cl.correo_id
        WHERE cl.lista_id = ANY($1)
      `, [listas]);
            } else {
                result = await db.query('SELECT email FROM correos');
            }

            const allEmails = result.rows.map(r => r.email);
            console.log('📬 Total de destinatarios únicos:', allEmails.length);

            const batchSize = 50;
            for (let i = 0; i < allEmails.length; i += batchSize) {
                const batch = allEmails.slice(i, i + batchSize);
                console.log(`✉️ Enviando lote ${i / batchSize + 1}...`);

                const mailOptions = {
                    from: 'labdiazgill@gmail.com',
                    to: batch.join(','),
                    subject: asunto,
                    html: `
          <div style="font-family: Arial, sans-serif; background: #f9f9f9; padding: 32px;">
            <div style="max-width: 600px; margin: auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 8px #eee; padding: 24px;">
              <div>${cuerpo}</div>
              <hr style="margin: 32px 0;">
              <div style="text-align: center; color: #888; font-size: 11px;">
                <img src="https://cdn-icons-png.flaticon.com/512/561/561127.png" alt="Correo" width="24" style="margin-bottom: 4px;" />
                <br>
                Este correo forma parte de una comunicación masiva enviada con fines informativos.
              </div>
            </div>
          </div>
        `
                };

                await transporter.sendMail(mailOptions);
                console.log(`✅ Lote ${i / batchSize + 1} enviado`);

                if (i + batchSize < allEmails.length) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }

            await db.query(
                'INSERT INTO envios (fecha, asunto, cuerpo) VALUES ($1, $2, $3)',
                [new Date().toISOString(), asunto, cuerpo]
            );

            res.send(`Correo enviado a ${allEmails.length} destinatarios únicos.`);
        } catch (err) {
            console.error('❌ Error al enviar correo:', err.message);
            res.status(500).send('Error al enviar correo.');
        }
    });

    // Borrar una lista y sus asociaciones
    router.delete('/:id', async (req, res) => {
        const listaId = req.params.id;
        try {
            // Elimina las asociaciones de correos con la lista
            await db.query('DELETE FROM correos_listas WHERE lista_id = $1', [listaId]);
            // Elimina la lista
            await db.query('DELETE FROM listas WHERE id = $1', [listaId]);
            res.send('Lista eliminada.');
        } catch (err) {
            console.error('❌ Error al eliminar lista:', err.message);
            res.status(500).send('Error al eliminar lista.');
        }
    });

    // Importar correos a una lista (evita duplicados)
    router.post('/:id/importar', async (req, res) => {
        const listaId = req.params.id;
        const { emails } = req.body;
        if (!Array.isArray(emails) || emails.length === 0) {
            return res.status(400).send('No se recibieron correos válidos.');
        }
        try {
            let total = emails.length;
            let importados = 0;
            let duplicados = 0;
            let malformados = 0;
            let yaEnLista = 0;
            const correoIds = [];
            const emailSet = new Set();
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

            for (const emailRaw of emails) {
                const email = emailRaw.trim().toLowerCase();
                if (!emailRegex.test(email)) {
                    malformados++;
                    continue;
                }
                if (emailSet.has(email)) {
                    duplicados++;
                    continue;
                }
                emailSet.add(email);

                const correoRes = await db.query(
                    'INSERT INTO correos (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id',
                    [email]
                );
                const correoId = correoRes.rows[0].id;
                // Verifica si ya está en la lista
                const yaEnListaRes = await db.query(
                    'SELECT 1 FROM correos_listas WHERE correo_id = $1 AND lista_id = $2',
                    [correoId, listaId]
                );
                if (yaEnListaRes.rowCount > 0) {
                    yaEnLista++;
                    continue;
                }
                await db.query(
                    'INSERT INTO correos_listas (correo_id, lista_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [correoId, listaId]
                );
                importados++;
            }
            res.json({
                total,
                importados,
                duplicados,
                malformados,
                yaEnLista
            });
        } catch (err) {
            console.error('❌ Error al importar correos:', err.message);
            res.status(500).send('Error al importar correos.');
        }
    });

    // Eliminar un correo de una lista
    router.delete('/:listaId/correos/:correoId', async (req, res) => {
        const { listaId, correoId } = req.params;
        try {
            await db.query('DELETE FROM correos_listas WHERE lista_id = $1 AND correo_id = $2', [listaId, correoId]);
            res.send('Correo eliminado de la lista.');
        } catch (err) {
            console.error('❌ Error al eliminar correo de lista:', err.message);
            res.status(500).send('Error al eliminar correo de la lista.');
        }
    });

    // Validar dominios de los correos de una lista (verifica existencia de registros MX)
    router.get('/:id/validar', async (req, res) => {
        const listaId = req.params.id;
        try {
            const result = await db.query(`
        SELECT c.email
        FROM correos c
        JOIN correos_listas cl ON c.id = cl.correo_id
        WHERE cl.lista_id = $1
        ORDER BY c.email
      `, [listaId]);

            const emails = result.rows.map(r => r.email);
            // extraer dominios únicos
            const domains = Array.from(new Set(
                emails
                    .map(e => (typeof e === 'string' ? e.split('@')[1] : ''))
                    .filter(Boolean)
            ));

            // helper: comprobar MX con timeout
            const checkDomainMx = async (domain) => {
                const timeoutMs = 1500;
                try {
                    const mx = await Promise.race([
                        dns.resolveMx(domain),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
                    ]);
                    return Array.isArray(mx) && mx.length > 0;
                } catch (_) {
                    return false;
                }
            };

            // validar con concurrencia limitada
            const concurrency = 10;
            const domainResults = {};
            let idx = 0;
            const workers = Array.from({ length: Math.min(concurrency, domains.length) }, async () => {
                while (true) {
                    const i = idx++;
                    if (i >= domains.length) break;
                    const d = domains[i];
                    domainResults[d] = await checkDomainMx(d);
                }
            });
            await Promise.all(workers);

            const details = emails.map(email => {
                const domain = (email && email.includes('@')) ? email.split('@')[1] : '';
                return { email, domain, hasMx: !!domainResults[domain] };
            });

            const total = details.length;
            const valid = details.filter(d => d.hasMx).length;
            const invalid = total - valid;

            res.json({ total, valid, invalid, details });
        } catch (err) {
            console.error('❌ Error al validar correos de lista:', err.message);
            res.status(500).send('Error al validar correos de la lista.');
        }
    });

    return router;
};
