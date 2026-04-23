const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// =========================================================
// 1. ENDPOINTS DE LOGIN Y REGISTRO (GLOBALES)
// =========================================================

app.post('/api/preventivistas/registro', async (req, res) => {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'registerPreventivista',
            preventivistaData: req.body
        });
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
// 2. ENDPOINTS DE GESTIÓN (AHORA CON CIUDAD)
// =========================================================

// Obtener turnos (Filtrados por ciudad)
app.get('/api/admin/turnos', async (req, res) => {
    try {
        // Leemos la ciudad que viene del frontend (?city=rosario)
        // Si no viene, por defecto 'santafe'
        const city = req.query.city || 'santafe';
        
        console.log(`[Admin] Solicitando turnos para: ${city}`);

        // Le pasamos la ciudad a Apps Script
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

// Derivaciones (Siguen siendo globales por ahora)
app.get('/api/admin/derivaciones', async (req, res) => {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, { action: 'getAllReferrals' });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Error al cargar derivaciones.' });
    }
});

// Endpoint para obtener la lista de días bloqueados (POR CIUDAD)
app.get('/api/admin/dias-bloqueados', async (req, res) => {
    try {
        const city = req.query.city || 'santafe';
        const response = await axios.post(APPS_SCRIPT_URL, { 
            action: 'getBlockedDays',
            city: city // Enviamos la ciudad elegida
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'No se pudieron cargar los días bloqueados.' });
    }
});

// Cancelar turno (Busca en todas las hojas por ID, no necesita ciudad explícita)
app.post('/api/cancelar', async (req, res) => {
    try {
        const { eventId } = req.body;
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'cancelAppointment',
            eventId: eventId
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error cancelling appointment:', error);
        res.status(500).json({ status: 'error', message: 'Error al cancelar el turno.' });
    }
});

// Endpoint para agregar turnos manualmente (personalizados)
app.post('/api/admin/agregar-turnos', async (req, res) => {
    try {
        // Recibimos: date, start, end, duration, city
        console.log(`[Admin] Agregando turnos extra para: ${req.body.city}`);
        
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'createCustomSlots',
            city: req.body.city, // Importante pasar la ciudad
            date: req.body.date,
            start: req.body.start,
            end: req.body.end,
            duration: req.body.duration
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error adding custom slots:', error);
        res.status(500).json({ status: 'error', message: 'Error al crear turnos.' });
    }
});

// Endpoint para DESBLOQUEAR un día
app.post('/api/admin/desbloquear-dia', async (req, res) => {
    try {
        const { date, city } = req.body;
        console.log(`[Admin] Desbloqueando día ${date} para ${city}`);
        
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'unblockDay',
            date: date,
            city: city
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error unblocking day:', error);
        res.status(500).json({ status: 'error', message: 'No se pudo desbloquear el día.' });
    }
});
// =========================================================
// Endpoint para BLOQUEAR un día (FALTABA ESTO)
// =========================================================
app.post('/api/admin/bloquear-dia', async (req, res) => {
    try {
        // Recibimos la fecha y la ciudad del frontend
        const { date, city } = req.body;
        
        console.log(`[Admin] Solicitud de bloqueo: Día ${date} para ${city || 'Global'}`);
        
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'blockDay', // Llamamos a la función en Apps Script
            date: date,
            city: city 
        });
        
        res.json(response.data);
    } catch (error) {
        console.error('Error blocking day:', error);
        res.status(500).json({ status: 'error', message: 'No se pudo bloquear el día.' });
    }
});

// =========================================================
// Endpoint para MOVER un turno a Fuerzas de Seguridad
// =========================================================
app.post('/api/admin/mover-fuerzas', async (req, res) => {
    try {
        const { idTurno, city } = req.body;
        console.log(`[Admin] Moviendo turno ${idTurno} desde ${city} a Fuerzas de Seguridad`);
        
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'moveToFuerzas',
            idTurno: idTurno,
            city: city
        });
        res.json(response.data);
    } catch (error) {
        console.error('Error moviendo turno a fuerzas:', error);
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
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Servidor Preventivistas corriendo en http://localhost:${PORT}`);
});