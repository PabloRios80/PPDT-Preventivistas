const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// =========================================================
// 1. LOGIN Y REGISTRO — escribe en Supabase Y Google Sheets
// =========================================================
app.post('/api/preventivistas/registro', async (req, res) => {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'registerPreventivista',
            preventivistaData: req.body
        });

        if (response.data.status === 'success') {
            const { dni, nombre, apellido, telefono, email } = req.body;
            const { error } = await supabase.from('preventivistas').upsert({
                dni,
                nombre,
                apellido,
                telefono,
                email,
                usuario: response.data.credentials.user,
                password: response.data.credentials.pass
            }, { onConflict: 'dni' });

            if (error) console.error('ERROR SUPABASE:', JSON.stringify(error));
            else console.log('✅ Guardado en Supabase:', dni);
        }

        res.json(response.data);
    } catch (error) {
        console.error('Error en registro:', error);
        res.status(500).json({ status: 'error', message: 'Error en el servidor.' });
    }
});
app.post('/api/preventivistas/login', async (req, res) => {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'loginPreventivista',
            credentials: req.body
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Error en el servidor.' });
    }
});

// =========================================================
// 2. TURNOS
// =========================================================

app.get('/api/admin/turnos', async (req, res) => {
    try {
        const city = req.query.city || 'santafe';
        console.log(`[Admin] Solicitando turnos para: ${city}`);
        const response = await axios.post(APPS_SCRIPT_URL, { 
            action: 'getAllAppointments',
            city: city 
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error fetching appointments:', error);
        res.status(500).json({ status: 'error', message: 'No se pudieron cargar los turnos.' });
    }
});

app.post('/api/cancelar', async (req, res) => {
    try {
        const { eventId } = req.body;
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'cancelAppointment',
            eventId: eventId
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Error al cancelar el turno.' });
    }
});

app.post('/api/admin/agregar-turnos', async (req, res) => {
    try {
        console.log(`[Admin] Agregando turnos masivos para: ${req.body.target}`);
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'createCustomSlots',
            target: req.body.target,
            date: req.body.date,
            start: req.body.start,
            end: req.body.end,
            duration: req.body.duration
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Error al crear turnos.' });
    }
});

app.post('/api/admin/mover-fuerzas', async (req, res) => {
    try {
        const { idTurno, city } = req.body;
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'moveToFuerzas',
            idTurno: idTurno,
            city: city
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Error al mover el turno.' });
    }
});

app.post('/api/admin/devolver-publico', async (req, res) => {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'returnToPublic',
            idTurno: req.body.idTurno
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Error al devolver turno.' });
    }
});

// =========================================================
// 3. DÍAS BLOQUEADOS
// =========================================================

app.get('/api/admin/dias-bloqueados', async (req, res) => {
    try {
        const city = req.query.city || 'santafe';
        const response = await axios.post(APPS_SCRIPT_URL, { 
            action: 'getBlockedDays',
            city: city
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'No se pudieron cargar los días bloqueados.' });
    }
});

app.post('/api/admin/bloquear-dia', async (req, res) => {
    try {
        const { date, city } = req.body;
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'blockDay',
            date: date,
            city: city 
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'No se pudo bloquear el día.' });
    }
});

app.post('/api/admin/desbloquear-dia', async (req, res) => {
    try {
        const { date, city } = req.body;
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'unblockDay',
            date: date,
            city: city
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'No se pudo desbloquear el día.' });
    }
});

// =========================================================
// 4. DERIVACIONES
// =========================================================

app.get('/api/admin/derivaciones', async (req, res) => {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, { action: 'getAllReferrals' });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Error al cargar derivaciones.' });
    }
});

// =========================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor Preventivistas corriendo en http://localhost:${PORT}`);
});