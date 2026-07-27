const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// =========================================================
// 1. LOGIN Y REGISTRO — escribe en Supabase Y Google Sheets
// =========================================================
app.post("/api/preventivistas/registro", async (req, res) => {
  try {
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: "registerPreventivista",
      preventivistaData: req.body,
    });

    if (response.data.status === "success") {
      const { dni, nombre, apellido, telefono, email } = req.body;
      const { error } = await supabase.from("preventivistas").upsert(
        {
          dni,
          nombre,
          apellido,
          telefono,
          email,
          usuario: response.data.credentials.user,
          password: response.data.credentials.pass,
        },
        { onConflict: "dni" },
      );

      if (error) console.error("ERROR SUPABASE:", JSON.stringify(error));
      else console.log("✅ Guardado en Supabase:", dni);
    }

    res.json(response.data);
  } catch (error) {
    console.error("Error en registro:", error);
    res.status(500).json({ status: "error", message: "Error en el servidor." });
  }
});
app.post("/api/preventivistas/login", async (req, res) => {
  try {
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: "loginPreventivista",
      credentials: req.body,
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ status: "error", message: "Error en el servidor." });
  }
});

// =========================================================
// 2. TURNOS
// =========================================================

app.get("/api/admin/turnos", async (req, res) => {
  try {
    const city = req.query.city || "santafe";
    console.log(`[Admin] Solicitando turnos para: ${city}`);
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: "getAllAppointments",
      city: city,
    });
    res.json(response.data);
  } catch (error) {
    console.error("Error fetching appointments:", error);
    res
      .status(500)
      .json({ status: "error", message: "No se pudieron cargar los turnos." });
  }
});

app.post("/api/cancelar", async (req, res) => {
  try {
    const { eventId } = req.body;
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: "cancelAppointment",
      eventId: eventId,
    });
    res.json(response.data);
  } catch (error) {
    res
      .status(500)
      .json({ status: "error", message: "Error al cancelar el turno." });
  }
});

app.post("/api/admin/agregar-turnos", async (req, res) => {
  try {
    console.log(`[Admin] Agregando turnos masivos para: ${req.body.target}`);
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: "createCustomSlots",
      target: req.body.target,
      date: req.body.date,
      start: req.body.start,
      end: req.body.end,
      duration: req.body.duration,
    });
    res.json(response.data);
  } catch (error) {
    res
      .status(500)
      .json({ status: "error", message: "Error al crear turnos." });
  }
});

app.post("/api/admin/mover-fuerzas", async (req, res) => {
  try {
    const { idTurno, city } = req.body;
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: "moveToFuerzas",
      idTurno: idTurno,
      city: city,
    });
    res.json(response.data);
  } catch (error) {
    res
      .status(500)
      .json({ status: "error", message: "Error al mover el turno." });
  }
});

app.post("/api/admin/devolver-publico", async (req, res) => {
  try {
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: "returnToPublic",
      idTurno: req.body.idTurno,
    });
    res.json(response.data);
  } catch (error) {
    res
      .status(500)
      .json({ status: "error", message: "Error al devolver turno." });
  }
});

// =========================================================
// 3. DÍAS BLOQUEADOS
// =========================================================

app.get("/api/admin/dias-bloqueados", async (req, res) => {
  try {
    const city = req.query.city || "santafe";
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: "getBlockedDays",
      city: city,
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: "No se pudieron cargar los días bloqueados.",
    });
  }
});

app.post("/api/admin/bloquear-dia", async (req, res) => {
  try {
    const { date, city } = req.body;
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: "blockDay",
      date: date,
      city: city,
    });
    res.json(response.data);
  } catch (error) {
    res
      .status(500)
      .json({ status: "error", message: "No se pudo bloquear el día." });
  }
});

app.post("/api/admin/desbloquear-dia", async (req, res) => {
  try {
    const { date, city } = req.body;
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: "unblockDay",
      date: date,
      city: city,
    });
    res.json(response.data);
  } catch (error) {
    res
      .status(500)
      .json({ status: "error", message: "No se pudo desbloquear el día." });
  }
});

// =========================================================
// 4. DERIVACIONES
// =========================================================

app.get("/api/admin/derivaciones", async (req, res) => {
  try {
    const response = await axios.post(APPS_SCRIPT_URL, {
      action: "getAllReferrals",
    });
    res.json(response.data);
  } catch (error) {
    res
      .status(500)
      .json({ status: "error", message: "Error al cargar derivaciones." });
  }
});

// ── AGENDA CIERRE DP ──

// Obtener agenda por sede y fecha
app.get("/api/agenda-cierre", async (req, res) => {
  const { id_sede_dp, fecha } = req.query;
  try {
    let query = supabase
      .from("agenda_cierre_dp")
      .select("*")
      .order("hora", { ascending: true });
    if (id_sede_dp) query = query.eq("id_sede_dp", id_sede_dp);
    if (fecha) query = query.eq("fecha", fecha);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ status: "success", turnos: data });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Agendar turno de cierre
app.post("/api/agenda-cierre", async (req, res) => {
  try {
    const { error } = await supabase.from("agenda_cierre_dp").insert(req.body);
    if (error) throw error;
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Actualizar estado (PRESENTE, REALIZADO, CANCELADO)
app.patch("/api/agenda-cierre/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("agenda_cierre_dp")
      .update(req.body)
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Eliminar turno
app.delete("/api/agenda-cierre/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("agenda_cierre_dp")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.get("/api/sedes-cierre", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("sedes_dp")
      .select("*")
      .eq("activo", true)
      .order("ciudad");
    if (error) throw error;
    res.json({ sedes: data });
  } catch (e) {
    res.status(500).json({ sedes: [] });
  }
});

// Médicos por sede
app.get("/api/medicos-cierre/:id_sede_dp", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("medicos_cierre_dp")
      .select("*")
      .eq("id_sede_dp", req.params.id_sede_dp)
      .eq("activo", true)
      .order("nombre");
    if (error) throw error;
    res.json({ status: "success", medicos: data });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});
app.get("/api/medicos-disponibles", async (req, res) => {
  const { id_sede_dp, fecha } = req.query;
  try {
    const diaSemana = new Date(fecha + "T12:00:00").getDay();

    // Primero traer médicos de la sede
    const { data: medicos } = await supabase
      .from("medicos_cierre_dp")
      .select("id, nombre")
      .eq("id_sede_dp", id_sede_dp)
      .eq("activo", true);

    if (!medicos || medicos.length === 0)
      return res.json({ status: "success", disponibles: [] });

    const idsMedicos = medicos.map((m) => m.id);

    // Luego traer disponibilidad de esos médicos para ese día
    const { data: disp } = await supabase
      .from("disponibilidad_medico_cierre")
      .select("*")
      .in("id_medico", idsMedicos)
      .eq("dia_semana", diaSemana)
      .eq("activo", true);

    // Combinar
    const disponibles = (disp || []).map((d) => ({
      ...d,
      medicos_cierre_dp: medicos.find((m) => m.id === d.id_medico),
    }));

    res.json({ status: "success", disponibles });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Slots disponibles de un médico en una fecha
app.get("/api/slots-medico", async (req, res) => {
  const { id_medico, fecha } = req.query;
  try {
    // 1. ¿Está el día completo bloqueado?
    const { data: diaBloqueado } = await supabase
      .from("dias_bloqueados_medico_cierre")
      .select("id")
      .eq("id_medico", id_medico)
      .eq("fecha", fecha)
      .maybeSingle();

    if (diaBloqueado) {
      return res.json({ status: "success", slots: [], diaBloqueado: true });
    }

    const diaSemana = new Date(fecha + "T12:00:00").getDay();

    const { data: disp } = await supabase
      .from("disponibilidad_medico_cierre")
      .select("*")
      .eq("id_medico", id_medico)
      .eq("dia_semana", diaSemana)
      .eq("activo", true)
      .single();

    const { data: ocupados } = await supabase
      .from("agenda_cierre_dp")
      .select("hora")
      .eq("id_medico", id_medico)
      .eq("fecha", fecha)
      .neq("estado", "CANCELADO");
    const horasOcupadas = new Set((ocupados || []).map((t) => t.hora));

    const { data: bloqueadosPuntual } = await supabase
      .from("slots_bloqueados_medico_cierre")
      .select("hora")
      .eq("id_medico", id_medico)
      .eq("fecha", fecha);
    const horasBloqueadas = new Set(
      (bloqueadosPuntual || []).map((b) => b.hora),
    );

    const { data: extras } = await supabase
      .from("slots_extra_medico_cierre")
      .select("hora")
      .eq("id_medico", id_medico)
      .eq("fecha", fecha);

    const slots = [];

    // Slots del patrón habitual
    if (disp) {
      const [hIni, mIni] = disp.hora_inicio.split(":").map(Number);
      const [hFin, mFin] = disp.hora_fin.split(":").map(Number);
      let actual = hIni * 60 + mIni;
      const fin = hFin * 60 + mFin;
      while (actual < fin) {
        const h = Math.floor(actual / 60)
          .toString()
          .padStart(2, "0");
        const m = (actual % 60).toString().padStart(2, "0");
        const horaStr = `${h}:${m}:00`;
        if (!horasBloqueadas.has(horaStr)) {
          slots.push({
            hora: horaStr,
            disponible: !horasOcupadas.has(horaStr),
            extra: false,
          });
        }
        actual += disp.duracion_minutos;
      }
    }

    // Slots extra puntuales
    (extras || []).forEach((e) => {
      if (!slots.find((s) => s.hora === e.hora)) {
        slots.push({
          hora: e.hora,
          disponible: !horasOcupadas.has(e.hora),
          extra: true,
        });
      }
    });

    slots.sort((a, b) => a.hora.localeCompare(b.hora));

    res.json({ status: "success", slots });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Verificar afiliado IAPOS desde ppdt-preventivistas
app.get("/api/verificar-afiliado/:dni", async (req, res) => {
  const dni = req.params.dni;
  const hoy = new Date().toISOString().split("T")[0];
  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
    <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
            <BEWsValidaAfi.Execute xmlns="IAPOS_WS">
                <Usuario>CONSULTAPDP</Usuario>
                <Passwd>1Qaz</Passwd>
                <Nafiliado>${dni}</Nafiliado>
                <Badocnumdo>${dni}</Badocnumdo>
                <Tidocodigo_de_documento>96</Tidocodigo_de_documento>
                <Ogorcodigo>1</Ogorcodigo>
                <Fechpresta>${hoy}</Fechpresta>
            </BEWsValidaAfi.Execute>
        </soap:Body>
    </soap:Envelope>`;
  try {
    const response = await axios.post(
      "https://aswe.santafe.gov.ar/iapos-sw-srvt/servlet/abewsvalidaafi",
      soapBody,
      {
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: "IAPOS_WSaction/ABEWSVALIDAAFI.Execute",
        },
        timeout: 10000,
      },
    );
    const xml = response.data;
    const get = (tag) => {
      const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`));
      return m ? m[1].trim() : null;
    };
    res.json({
      esActivo: get("Estado") === "A",
      nombre: get("Apenom"),
      edad: get("Edad"),
    });
  } catch (e) {
    res.status(500).json({ esActivo: false, error: e.message });
  }
});

// Agregar médico
app.post("/api/medicos-cierre", async (req, res) => {
  try {
    const { error } = await supabase.from("medicos_cierre_dp").insert(req.body);
    if (error) throw error;
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Desactivar médico
app.patch("/api/medicos-cierre/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("medicos_cierre_dp")
      .update(req.body)
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Traer disponibilidad de un médico
app.get("/api/disponibilidad-medico/:id_medico", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("disponibilidad_medico_cierre")
      .select("*")
      .eq("id_medico", req.params.id_medico)
      .eq("activo", true)
      .order("dia_semana");
    if (error) throw error;
    res.json({ status: "success", disponibilidad: data });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Agregar disponibilidad
app.post("/api/disponibilidad-medico", async (req, res) => {
  try {
    const { error } = await supabase
      .from("disponibilidad_medico_cierre")
      .insert(req.body);
    if (error) throw error;
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Eliminar disponibilidad
app.delete("/api/disponibilidad-medico/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("disponibilidad_medico_cierre")
      .delete()
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.get("/api/medicos-internos", async (req, res) => {
  const { id_sede_dp } = req.query;
  try {
    let query = supabase
      .from("profesionales")
      .select("id, nombre, apellido, especialidad")
      .eq("puede_cerrar_interno", true)
      .eq("activo", true);
    if (id_sede_dp) query = query.eq("id_sede_dp", parseInt(id_sede_dp));
    const { data, error } = await query.order("apellido");
    if (error) throw error;
    res.json({ medicos: data || [] });
  } catch (e) {
    res.status(500).json({ medicos: [] });
  }
});
// Agregar turno extra puntual
app.post("/api/slots-extra-medico", async (req, res) => {
  try {
    const { error } = await supabase
      .from("slots_extra_medico_cierre")
      .insert(req.body);
    if (error) throw error;
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Bloquear un horario puntual dentro de un día habitual
app.post("/api/slots-bloqueados-medico", async (req, res) => {
  try {
    const { error } = await supabase
      .from("slots_bloqueados_medico_cierre")
      .insert(req.body);
    if (error) throw error;
    res.json({ status: "success" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Bloquear día completo (con aviso de turnos existentes, sin impedir)
app.post("/api/dias-bloqueados-medico", async (req, res) => {
  const { id_medico, fecha, motivo } = req.body;
  try {
    // Chequear turnos existentes ese día (solo para avisar)
    const { data: turnosExistentes } = await supabase
      .from("agenda_cierre_dp")
      .select("id, dni, apellido_y_nombre, hora")
      .eq("id_medico", id_medico)
      .eq("fecha", fecha)
      .neq("estado", "CANCELADO");

    const { error } = await supabase
      .from("dias_bloqueados_medico_cierre")
      .insert({ id_medico, fecha, motivo });
    if (error) throw error;

    res.json({
      status: "success",
      turnosAfectados: turnosExistentes || [],
    });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Listar excepciones de un médico (para mostrarlas en el modal)
app.get("/api/excepciones-medico/:id_medico", async (req, res) => {
  try {
    const [extras, bloqueados, dias] = await Promise.all([
      supabase
        .from("slots_extra_medico_cierre")
        .select("*")
        .eq("id_medico", req.params.id_medico)
        .order("fecha"),
      supabase
        .from("slots_bloqueados_medico_cierre")
        .select("*")
        .eq("id_medico", req.params.id_medico)
        .order("fecha"),
      supabase
        .from("dias_bloqueados_medico_cierre")
        .select("*")
        .eq("id_medico", req.params.id_medico)
        .order("fecha"),
    ]);
    res.json({
      status: "success",
      extras: extras.data || [],
      bloqueados: bloqueados.data || [],
      diasBloqueados: dias.data || [],
    });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Eliminar una excepción puntual
app.delete("/api/slots-extra-medico/:id", async (req, res) => {
  await supabase
    .from("slots_extra_medico_cierre")
    .delete()
    .eq("id", req.params.id);
  res.json({ status: "success" });
});
app.delete("/api/slots-bloqueados-medico/:id", async (req, res) => {
  await supabase
    .from("slots_bloqueados_medico_cierre")
    .delete()
    .eq("id", req.params.id);
  res.json({ status: "success" });
});
app.delete("/api/dias-bloqueados-medico/:id", async (req, res) => {
  await supabase
    .from("dias_bloqueados_medico_cierre")
    .delete()
    .eq("id", req.params.id);
  res.json({ status: "success" });
});
// =========================================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor Preventivistas corriendo en http://localhost:${PORT}`);
});
