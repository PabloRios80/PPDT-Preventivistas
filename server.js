require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const XLSX = require("xlsx");
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // hasta 25MB, de sobra para ~20.000 filas
});

const app = express();
const PORT = process.env.PORT || 3001;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

app.use(express.json());
app.use(express.static("public"));

// ==========================================
// RUTAS API
// ==========================================

// --- Pendientes clínicos ---
app.get("/api/pendientes", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("practicas_autorizadas")
      .select("*")
      .eq("estado", "AUTORIZADA")
      .order("fecha_autorizacion", { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Alertas clínicas urgentes ---
app.get("/api/alertas", async (req, res) => {
  const { id_sede_dp } = req.query;
  try {
    // Buscamos casos con HPV patológico sin PAP realizado
    let queryHpv = supabase
      .from("historial_dia_preventivo")
      .select(
        "dni, apellido_y_nombre, fechax, cancer_cervico_hpv, cancer_cervico_pap, efector",
      )
      .eq("cancer_cervico_hpv", "Patologico")
      .order("fechax", { ascending: false });
    if (id_sede_dp) queryHpv = queryHpv.eq("id_sede_dp", id_sede_dp);
    const { data: hpvPositivos } = await queryHpv;

    // Buscamos SOMF patológico sin VCC
    let querySomf = supabase
      .from("historial_dia_preventivo")
      .select(
        "dni, apellido_y_nombre, fechax, somf, cancer_colon_colonoscopia, efector",
      )
      .eq("somf", "Patologico")
      .order("fechax", { ascending: false });
    if (id_sede_dp) querySomf = querySomf.eq("id_sede_dp", id_sede_dp);
    const { data: somfPositivos } = await querySomf;

    // Filtramos los que no tienen la práctica de seguimiento realizada
    const alertasHPV = (hpvPositivos || []).map((p) => ({
      ...p,
      tipo_alerta: "HPV_POSITIVO",
      practica_pendiente: "papanicolau",
      prioridad: "ALTA",
      mensaje: "HPV Patológico — PAP no realizado",
    }));

    const alertasSOMF = (somfPositivos || []).map((p) => ({
      ...p,
      tipo_alerta: "SOMF_POSITIVO",
      practica_pendiente: "videocolonoscopia - VCC",
      prioridad: "ALTA",
      mensaje: "SOMF Patológico — VCC no realizada",
    }));

    res.json({
      success: true,
      alertas: [...alertasHPV, ...alertasSOMF],
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Facturación por mes ---
app.get("/api/facturacion/:mes/:anio", async (req, res) => {
  const { mes, anio } = req.params;
  const { id_sede_dp } = req.query;
  const fechaInicio = `${anio}-${mes.padStart(2, "0")}-01`;
  const fechaFin = new Date(anio, mes, 0).toISOString().split("T")[0];

  try {
    // Prácticas de prestadores externos
    let queryPracticas = supabase
      .from("practicas_autorizadas")
      .select("*")
      .eq("estado", "REALIZADA")
      .gte("fecha_carga", fechaInicio)
      .lte("fecha_carga", fechaFin);
    if (id_sede_dp) queryPracticas = queryPracticas.eq("id_sede_dp", id_sede_dp);
    const { data: practicas } = await queryPracticas;

    // Consultas médicas desde historial
    let queryCierres = supabase
      .from("historial_dia_preventivo")
      .select("dni, apellido_y_nombre, fechax, profesional, efector")
      .gte("fechax", fechaInicio)
      .lte("fechax", fechaFin)
      .not("profesional", "is", null);
    if (id_sede_dp) queryCierres = queryCierres.eq("id_sede_dp", id_sede_dp);
    const { data: cierres } = await queryCierres;

    const consultasMedicas = (cierres || []).map((c) => ({
      dni: c.dni,
      nombre_completo: c.apellido_y_nombre,
      descripcion_practica: "MEDICO (por cada Día Preventivo)",
      codigo_prestacion: "B040101",
      nombre_prestador: c.profesional,
      fecha_carga: c.fechax,
      estado: "REALIZADA",
    }));

    const todasLasPracticas = [...(practicas || []), ...consultasMedicas];

    res.json({ success: true, data: todasLasPracticas });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
const PRACTICAS_EXCLUIR_CIERRE = [
  "consejeria/tratamiento tabaquismo",
  "consejeria/tratamiento alcohol y/o drogas",
  "consejeria/tratamiento violencia familiar",
  "consejeria/tratamiento depresion",
  "consejeria actividad fisica",
  "consejeria/tratamiento caida adultos mayores",
  "consejeria",
  "tomar ta ambos brazos personal capacitado",
  "calcular imc",
  "control vision",
  "vacunas",
  "enseñanza técnica h.o.",
  "topicacion con fluor",
  "topicación con flúor",
  // Prácticas secundarias que generalmente se indican DESPUÉS del cierre
  // (código SIOS entre paréntesis) — no cuentan para determinar si el
  // afiliado está listo para cerrar el DP.
  "videocolonoscopia - vcc", // 205011
  "hemoglobina glicosilada", // 679919
  "proteinuria", // 679920
  "microalbuminuria", // 679921 (cubre "microalbuminuria" y "Microalbuminuria")
  "rac - relación albúmina/creatinina",
  "papanicolau", // 225002
  "control odontologico", // redundante con "Consulta odontológica"
  // Registros de facturación generados automáticamente al cerrar el DP,
  // no son prácticas clínicas pendientes del afiliado.
  "consulta médica (día preventivo)",
  "módulo día preventivo",
];

// Ojo: "creatinina" sola NO va en la lista de arriba (es un estudio
// importante que SÍ cuenta para el cierre). Solo el ítem combinado
// "creatinina, clearence de depuración" (679922) queda excluido, y se
// chequea aparte más abajo por requerir ambas palabras juntas.
function esCreatininaClearenceCombinada(descLower) {
  return descLower.includes("creatinina") && descLower.includes("clearence");
}

const PRACTICAS_RECOMENDABLES_NO_BLOQUEANTES = [
  "espirometria",
  "densitometria osea",
];
app.get("/api/listos-para-cierre", async (req, res) => {
  try {
    const { data } = await supabase
      .from("practicas_autorizadas")
      .select("dni, nombre_completo, estado, descripcion_practica, fecha_carga")
      .order("dni");

    // Agrupamos por DNI excluyendo las consejerías
    const porDNI = {};
    (data || []).forEach((p) => {
      // Ignoramos consejerías
      const descLower = p.descripcion_practica.toLowerCase().trim();
      if (
        PRACTICAS_EXCLUIR_CIERRE.some((c) => descLower.includes(c)) ||
        esCreatininaClearenceCombinada(descLower)
      )
        return;

      if (!porDNI[p.dni]) {
        porDNI[p.dni] = {
          dni: p.dni,
          nombre: p.nombre_completo,
          total: 0,
          realizadas: 0,
          practicas: [],
        };
      }
      porDNI[p.dni].total++;
      if (p.estado === "REALIZADA") porDNI[p.dni].realizadas++;
      porDNI[p.dni].practicas.push(p);
    });

    const listos = Object.values(porDNI).filter(
      (p) => p.total > 0 && p.total === p.realizadas,
    );
    const enProceso = Object.values(porDNI).filter(
      (p) => p.realizadas > 0 && p.realizadas < p.total,
    );
    const sinIniciar = Object.values(porDNI).filter((p) => p.realizadas === 0);

    res.json({ success: true, listos, enProceso, sinIniciar });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Derivaciones ---
app.get("/api/derivaciones", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("derivaciones")
      .select("*")
      .order("fecha_derivacion", { ascending: false });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/api/derivaciones", async (req, res) => {
  try {
    const { error } = await supabase.from("derivaciones").insert(req.body);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.patch("/api/derivaciones/:id", async (req, res) => {
  try {
    const { error } = await supabase
      .from("derivaciones")
      .update(req.body)
      .eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
app.get("/api/cierre-dp/listos", async (req, res) => {
  const { id_sede_dp, dni, reparticion } = req.query;
  try {
    // Misma corrección que en /api/seguimiento: paginar para no perder
    // filas por el límite de 1000 que aplica Supabase/PostgREST por defecto.
    let practicas = [];
    let desdeListos = 0;
    const PAGINA_LISTOS = 1000;
    while (true) {
      const { data: bloqueListos, error: errorListos } = await supabase
        .from("practicas_autorizadas")
        .select("id, dni, nombre_completo, estado, descripcion_practica, id_sede_dp")
        .order("id", { ascending: true })
        .range(desdeListos, desdeListos + PAGINA_LISTOS - 1);

      if (errorListos) throw errorListos;
      if (!bloqueListos || bloqueListos.length === 0) break;

      practicas = practicas.concat(bloqueListos);
      desdeListos += PAGINA_LISTOS;
      if (bloqueListos.length < PAGINA_LISTOS) break;
    }

    if (!practicas || practicas.length === 0)
      return res.json({
        success: true,
        listos: [],
        manual: [],
        oficio: [],
        cerrados: { count: 0, detalle: [] },
      });

    // Filtrar por sede/dni ANTES de agrupar, sobre las filas crudas.
    // Se filtra directo por el id_sede_dp de cada fila (ya confiable tras
    // el backfill), sin pasar por tablero_dia — ese cruce perdía pacientes
    // genuinamente cerrados que no tenían fila de ingreso ahí (por ejemplo
    // cierres de oficio, o el primer mes usando este circuito).
    const practicasFiltradas = practicas.filter((p) => {
      if (id_sede_dp && p.id_sede_dp !== parseInt(id_sede_dp)) return false;
      if (dni && !p.dni.includes(dni.trim())) return false;
      return true;
    });

    const practicasPorDni = {};
    const nombrePorDni = {};
    practicasFiltradas.forEach((p) => {
      if (!practicasPorDni[p.dni]) practicasPorDni[p.dni] = [];
      practicasPorDni[p.dni].push(p);
      if (p.nombre_completo) nombrePorDni[p.dni] = p.nombre_completo;
    });

    // Edad de cada paciente, para saber quiénes son menores — se necesita
    // ANTES de procesar cada dni, porque cambia cómo se trata "Práctica
    // bioquímica" (obligatoria en adultos, excepcionable en menores).
    // OJO: no se puede sacar de historial_dia_preventivo, porque esa tabla
    // recién se completa cuando el cierre YA se hizo con éxito — para
    // casos todavía trabados (que es justo el caso que nos importa acá)
    // esa tabla está vacía. Se usa afiliados/afiliados_menores, que
    // existen para cualquier persona, haya cerrado o no.
    const { data: cierresEdad } = await supabase
      .from("historial_dia_preventivo")
      .select("dni, fechax, edad")
      .order("fechax", { ascending: false });

    const dnisParaEdad = Object.keys(practicasPorDni);
    const edadPorDni = {};
    for (let i = 0; i < dnisParaEdad.length; i += 500) {
      const lote = dnisParaEdad.slice(i, i + 500);
      const { data: bloqueAdultos } = await supabase
        .from("afiliados")
        .select("dni, edad")
        .in("dni", lote);
      (bloqueAdultos || []).forEach((a) => {
        edadPorDni[a.dni] = a.edad;
      });
      const { data: bloqueMenores } = await supabase
        .from("afiliados_menores")
        .select("dni, edad")
        .in("dni", lote);
      (bloqueMenores || []).forEach((m) => {
        edadPorDni[m.dni] = m.edad;
      });
    }
    // Tercera fuente de respaldo: tablero_dia guarda la edad tal como la
    // devolvió el padrón de IAPOS al momento de la admisión, incluso para
    // afiliados que nunca llegaron a completarse en afiliados/afiliados_menores.
    const dnisSinEdad = dnisParaEdad.filter(
      (d) => edadPorDni[d] === undefined,
    );
    for (let i = 0; i < dnisSinEdad.length; i += 500) {
      const lote = dnisSinEdad.slice(i, i + 500);
      const { data: bloqueTablero } = await supabase
        .from("tablero_dia")
        .select("dni, edad")
        .in("dni", lote)
        .not("edad", "is", null);
      (bloqueTablero || []).forEach((t) => {
        if (edadPorDni[t.dni] === undefined) edadPorDni[t.dni] = t.edad;
      });
    }

    // Repartición (Población General, Fuerzas de Seguridad, Docente, etc.)
    // se elige al admitir al paciente en Tablero del Día — se cruza igual
    // que la sede, tomando el dato más reciente por dni.
    let reparticionPorDni = {};
    if (reparticion) {
      const dnisParaReparticion = Object.keys(practicasPorDni);
      let filasReparticion = [];
      for (let i = 0; i < dnisParaReparticion.length; i += 500) {
        const lote = dnisParaReparticion.slice(i, i + 500);
        const { data: bloqueReparticion } = await supabase
          .from("tablero_dia")
          .select("dni, reparticion, fecha")
          .in("dni", lote)
          .not("reparticion", "is", null)
          .order("fecha", { ascending: false });
        filasReparticion = filasReparticion.concat(bloqueReparticion || []);
      }
      filasReparticion.forEach((f) => {
        if (reparticionPorDni[f.dni] === undefined)
          reparticionPorDni[f.dni] = f.reparticion;
      });
    }

    const porDni = {};
    Object.keys(practicasPorDni).forEach((dniActual) => {
      if (
        reparticion &&
        reparticionPorDni[dniActual] !== reparticion
      )
        return;

      const listaCruda = practicasPorDni[dniActual];
      const edadDni = edadPorDni[dniActual];
      const esMenorDni =
        edadDni !== undefined && edadDni !== null && edadDni < 18;

      porDni[dniActual] = {
        dni: dniActual,
        nombre: nombrePorDni[dniActual] || "",
        total: 0,
        realizadas: 0,
        practicas: [],
        recomendablesPendientes: [],
        yaCerrado: false,
      };

      // El médico ya completó el formulario de cierre (presencial o de
      // oficio, es indistinto): este DNI ya no está "pendiente de cierre",
      // pasa a la columna "Cerrados" (carga a SIOS).
      if (
        listaCruda.some(
          (p) =>
            p.descripcion_practica.toLowerCase().trim() ===
              "módulo día preventivo" && p.estado === "REALIZADA",
        )
      ) {
        porDni[dniActual].yaCerrado = true;

        // Para el detalle de "Cerrados" (no para Listos/Oficio) mostramos
        // también las dos filas de facturación que confirman que el
        // cierre disparó correctamente el módulo institucional.
        ["Consulta médica (Día Preventivo)", "Módulo Día Preventivo"].forEach(
          (desc) => {
            const fila = listaCruda.find(
              (p) =>
                p.descripcion_practica.toLowerCase().trim() ===
                desc.toLowerCase(),
            );
            if (fila) {
              porDni[dniActual].practicas.push({
                id: fila.id,
                descripcion: fila.descripcion_practica,
                estado: fila.estado,
              });
            }
          },
        );
      }

      // 1. Prácticas normales (excluyendo consejerías/TA/IMC/etc. y recomendables)
      listaCruda.forEach((p) => {
        const descLower = p.descripcion_practica.toLowerCase().trim();

        const esRecomendable = PRACTICAS_RECOMENDABLES_NO_BLOQUEANTES.some(
          (c) => descLower.includes(c),
        );
        if (esRecomendable) {
          if (p.estado !== "REALIZADA") {
            porDni[dniActual].recomendablesPendientes.push(
              p.descripcion_practica,
            );
          }
          return;
        }

        const esExcluida =
          PRACTICAS_EXCLUIR_CIERRE.some((c) => descLower.includes(c)) ||
          esCreatininaClearenceCombinada(descLower) ||
          descLower === "consulta de enfermería" ||
          descLower === "consulta odontológica" ||
          (descLower === "práctica bioquímica" && !esMenorDni);
        if (esExcluida) return;

        porDni[dniActual].total++;
        if (p.estado === "REALIZADA" || p.estado === "EXCEPCIONADA")
          porDni[dniActual].realizadas++;
        porDni[dniActual].practicas.push({
          id: p.id,
          descripcion: p.descripcion_practica,
          estado: p.estado,
        });
      });

      // 2. Inyectar Enfermería (siempre obligatoria)
      const enfRealizada = listaCruda.some(
        (p) =>
          p.descripcion_practica.toLowerCase().trim() ===
            "consulta de enfermería" && p.estado === "REALIZADA",
      );
      porDni[dniActual].total++;
      if (enfRealizada) porDni[dniActual].realizadas++;
      porDni[dniActual].practicas.unshift({
        descripcion: "Consulta de enfermería",
        estado: enfRealizada ? "REALIZADA" : "AUTORIZADA",
      });

      // 3. Inyectar Odontología (siempre obligatoria)
      const odonRealizada = listaCruda.some(
        (p) =>
          p.descripcion_practica.toLowerCase().trim() ===
            "consulta odontológica" && p.estado === "REALIZADA",
      );
      porDni[dniActual].total++;
      if (odonRealizada) porDni[dniActual].realizadas++;
      porDni[dniActual].practicas.unshift({
        descripcion: "Consulta odontológica",
        estado: odonRealizada ? "REALIZADA" : "AUTORIZADA",
      });

      // 4. Inyectar Bioquímico — obligatorio solo en ADULTOS (aunque el
      // paciente decline los análisis, el bioquímico igual debe intervenir
      // para informarlo, y cobra por eso). En MENORES no se indica de
      // rutina — solo si enfermería/bioquímica la agregan explícitamente,
      // y en ese caso ya se cuenta como una práctica normal/excepcionable
      // más arriba (bloque 1), sin forzar nada acá.
      if (!esMenorDni) {
        const bioRealizada = listaCruda.some(
          (p) =>
            p.descripcion_practica.toLowerCase().trim() ===
              "práctica bioquímica" && p.estado === "REALIZADA",
        );
        porDni[dniActual].total++;
        if (bioRealizada) porDni[dniActual].realizadas++;
        porDni[dniActual].practicas.unshift({
          descripcion: "Práctica bioquímica",
          estado: bioRealizada ? "REALIZADA" : "AUTORIZADA",
        });
      }
    });


    // ultimoCierre reutiliza los mismos datos ya traídos arriba (cierresEdad)
    const ultimoCierre = {};
    if (cierresEdad) {
      cierresEdad.forEach((c) => {
        if (!ultimoCierre[c.dni]) ultimoCierre[c.dni] = c.fechax;
      });
    }

    // DNIs con "Cierre de oficio" ya marcado por el PV, esperando que el
    // médico complete el formulario real.
    const { data: oficiosMarcados } = await supabase
      .from("cierre_oficio_marcado")
      .select("dni, marcado_por, fecha_marcado")
      .order("fecha_marcado", { ascending: false });

    const oficioPorDni = {};
    (oficiosMarcados || []).forEach((o) => {
      if (!oficioPorDni[o.dni]) oficioPorDni[o.dni] = o;
    });

    const hoy = new Date();
    const listos = [];
    const manual = [];
    const oficio = [];
    const cerrados = [];

    Object.values(porDni).forEach((p) => {
      const uc = ultimoCierre[p.dni];
      const diasDesdeUltimo = uc
        ? Math.floor((hoy - new Date(uc)) / (1000 * 60 * 60 * 24))
        : null;

      p.ultimoCierre = uc || null;
      p.diasDesdeUltimo = diasDesdeUltimo;

      // Ya fue cerrado por el médico: pasa a "Cerrados", no a
      // "pendientes de cierre". Este chequeo va ANTES del mínimo de
      // prácticas: estar cerrado ya es prueba de que fue un Día
      // Preventivo real, sin importar cuántas prácticas individuales
      // quedaron autorizadas en el detalle (varía caso a caso).
      if (p.yaCerrado) {
        cerrados.push(p);
        return;
      }

      // Casos con muy pocas prácticas autorizadas en total no representan
      // un ciclo real de Día Preventivo (carga parcial/vieja/incompleta):
      // mínimo 10 para adultos, 4 para pediátricos. Si no conocemos la
      // edad, se aplica el mínimo de adultos por prudencia.
      const edad = edadPorDni[p.dni];
      const esMenor = edad !== undefined && edad !== null && edad < 18;
      const minimoRequerido = esMenor ? 4 : 10;
      if (p.total < minimoRequerido) return;

      const marcadoOficio = oficioPorDni[p.dni];
      if (marcadoOficio) {
        p.marcadoPor = marcadoOficio.marcado_por;
        p.fechaMarcado = marcadoOficio.fecha_marcado;
        oficio.push(p);
      } else if (p.total > 0 && p.realizadas === p.total) {
        listos.push(p);
      }
    });

    res.json({
      success: true,
      listos,
      manual,
      oficio,
      cerrados: {
        count: cerrados.length,
        // El detalle (con nombre, prácticas, etc.) solo se manda cuando
        // hay un filtro de DNI activo — no se lista todo por defecto.
        detalle: dni ? cerrados : [],
      },
    });
  } catch (e) {
    console.error("Error cierre-dp:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Login CRM ---
app.post("/api/login", async (req, res) => {
  const { usuario, password } = req.body;
  try {
    const { data, error } = await supabase
      .from("preventivistas")
      .select("*")
      .eq("usuario", usuario)
      .eq("password", password)
      .single();

    if (error || !data) {
      return res.json({
        success: false,
        message: "Usuario o contraseña incorrectos.",
      });
    }

    res.json({
      success: true,
      usuario: {
        id: data.id,
        nombre: data.nombre,
        apellido: data.apellido,
        id_sede_dp: data.id_sede_dp,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// --- Sedes DP ---
app.get("/api/sedes", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("sedes_dp")
      .select("*")
      .eq("activo", true)
      .order("ciudad");
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});
// --- Seguimiento por sede ---
const LABORATORIO_KEYWORDS = [
  "glucemia",
  "colesterol",
  "creatinina",
  "filtrado",
  "trigliceridos",
  "anti_vih",
  "hepatitis",
  "chagas",
  "vdrl",
  "psa",
  "hpv",
  "hemoglobina",
  "microalbuminuria",
  "proteinuria",
  "clearence",
  "somf",
];

app.get("/api/seguimiento", async (req, res) => {
  const { id_sede_dp, dni } = req.query;
  try {
    let queryTablero = supabase
      .from("tablero_dia")
      .select("dni, apellido_y_nombre, created_at")
      .eq("tipo_visita", "DP");

    if (id_sede_dp)
      queryTablero = queryTablero.eq("id_sede_dp", parseInt(id_sede_dp));
    if (dni) queryTablero = queryTablero.ilike("dni", `%${dni}%`);

    const { data: ingresos } = await queryTablero;
    if (!ingresos || ingresos.length === 0)
      return res.json({ success: true, afiliados: [] });

    const primerIngresoPorDni = {};
    ingresos.forEach((i) => {
      if (
        !primerIngresoPorDni[i.dni] ||
        new Date(i.created_at) < new Date(primerIngresoPorDni[i.dni])
      ) {
        primerIngresoPorDni[i.dni] = i.created_at;
      }
    });

    const dnis = [...new Set(ingresos.map((i) => i.dni))];

    // Supabase/PostgREST corta silenciosamente en 1000 filas por consulta.
    // Con muchos afiliados activos, el total de practicas_autorizadas
    // supera fácilmente ese límite — hay que paginar para traerlas todas,
    // sino los DNIs que caen después del corte quedan con datos incompletos.
    let practicas = [];
    let desde = 0;
    const PAGINA = 1000;
    while (true) {
      const { data: bloque, error: errorPractica } = await supabase
        .from("practicas_autorizadas")
        .select("id, dni, nombre_completo, descripcion_practica, estado")
        .in("dni", dnis)
        .order("id", { ascending: true })
        .range(desde, desde + PAGINA - 1);

      if (errorPractica) throw errorPractica;
      if (!bloque || bloque.length === 0) break;

      practicas = practicas.concat(bloque);
      desde += PAGINA;
      if (bloque.length < PAGINA) break;
    }

    // Edad de cada paciente, para saber quiénes son menores — cambia cómo
    // se trata "Práctica bioquímica" (obligatoria en adultos, excepcionable
    // en menores), igual criterio que en /api/cierre-dp/listos. Se usa
    // afiliados/afiliados_menores (no historial_dia_preventivo, que recién
    // se completa cuando el cierre YA se hizo con éxito).
    const edadPorDniSeg = {};
    for (let i = 0; i < dnis.length; i += 500) {
      const lote = dnis.slice(i, i + 500);
      const { data: bloqueAdultosSeg } = await supabase
        .from("afiliados")
        .select("dni, edad")
        .in("dni", lote);
      (bloqueAdultosSeg || []).forEach((a) => {
        edadPorDniSeg[a.dni] = a.edad;
      });
      const { data: bloqueMenoresSeg } = await supabase
        .from("afiliados_menores")
        .select("dni, edad")
        .in("dni", lote);
      (bloqueMenoresSeg || []).forEach((m) => {
        edadPorDniSeg[m.dni] = m.edad;
      });
    }
    // Tercera fuente de respaldo, igual que en /api/cierre-dp/listos.
    const dnisSinEdadSeg = dnis.filter((d) => edadPorDniSeg[d] === undefined);
    for (let i = 0; i < dnisSinEdadSeg.length; i += 500) {
      const lote = dnisSinEdadSeg.slice(i, i + 500);
      const { data: bloqueTableroSeg } = await supabase
        .from("tablero_dia")
        .select("dni, edad")
        .in("dni", lote)
        .not("edad", "is", null);
      (bloqueTableroSeg || []).forEach((t) => {
        if (edadPorDniSeg[t.dni] === undefined) edadPorDniSeg[t.dni] = t.edad;
      });
    }

    const porDni = {};
    ingresos.forEach((i) => {
      if (!porDni[i.dni]) {
        porDni[i.dni] = {
          dni: i.dni,
          nombre: i.apellido_y_nombre,
          total: 0,
          realizadas: 0,
          practicas: [],
          primerIngreso: primerIngresoPorDni[i.dni],
        };
      }
    });

    // Agrupar prácticas crudas por DNI, para poder chequear existencia de estaciones y de laboratorio
    const practicasPorDni = {};
    (practicas || []).forEach((p) => {
      if (!practicasPorDni[p.dni]) practicasPorDni[p.dni] = [];
      practicasPorDni[p.dni].push(p);
    });

    Object.keys(porDni).forEach((dniActual) => {
      const listaCruda = practicasPorDni[dniActual] || [];
      const edadDniSeg = edadPorDniSeg[dniActual];
      const esMenorDni =
        edadDniSeg !== undefined && edadDniSeg !== null && edadDniSeg < 18;

      // 1. Cargar prácticas normales (excluyendo consejerías/TA/IMC/etc. y recomendables)
      listaCruda.forEach((p) => {
        const descLower = p.descripcion_practica.toLowerCase().trim();
        if (
          PRACTICAS_EXCLUIR_CIERRE.some((c) => descLower.includes(c)) ||
          esCreatininaClearenceCombinada(descLower) ||
          PRACTICAS_RECOMENDABLES_NO_BLOQUEANTES.some((c) =>
            descLower.includes(c),
          ) ||
          descLower === "consulta de enfermería" ||
          descLower === "consulta odontológica" ||
          (descLower === "práctica bioquímica" && !esMenorDni)
        )
          return;

        porDni[dniActual].total++;
        if (p.estado === "REALIZADA" || p.estado === "EXCEPCIONADA")
          porDni[dniActual].realizadas++;
        porDni[dniActual].practicas.push({
          id: p.id,
          descripcion: p.descripcion_practica,
          estado: p.estado,
        });
      });

      // 2. Inyectar Enfermería (siempre obligatoria)
      const enfRealizada = listaCruda.some(
        (p) =>
          p.descripcion_practica.toLowerCase().trim() ===
            "consulta de enfermería" && p.estado === "REALIZADA",
      );
      porDni[dniActual].total++;
      if (enfRealizada) porDni[dniActual].realizadas++;
      porDni[dniActual].practicas.unshift({
        descripcion: "Consulta de enfermería",
        estado: enfRealizada ? "REALIZADA" : "AUTORIZADA",
      });

      // 3. Inyectar Odontología (siempre obligatoria)
      const odonRealizada = listaCruda.some(
        (p) =>
          p.descripcion_practica.toLowerCase().trim() ===
            "consulta odontológica" && p.estado === "REALIZADA",
      );
      porDni[dniActual].total++;
      if (odonRealizada) porDni[dniActual].realizadas++;
      porDni[dniActual].practicas.unshift({
        descripcion: "Consulta odontológica",
        estado: odonRealizada ? "REALIZADA" : "AUTORIZADA",
      });

      // 4. Inyectar Bioquímico — obligatorio solo en ADULTOS (aunque el
      // paciente decline los análisis, el bioquímico igual debe intervenir
      // para informarlo, y cobra por eso). En MENORES no se indica de
      // rutina — solo si enfermería/bioquímica la agregan explícitamente,
      // y en ese caso ya se cuenta como una práctica normal/excepcionable
      // más arriba (bloque 1), sin forzar nada acá.
      if (!esMenorDni) {
        const bioRealizada = listaCruda.some(
          (p) =>
            p.descripcion_practica.toLowerCase().trim() ===
              "práctica bioquímica" && p.estado === "REALIZADA",
        );
        porDni[dniActual].total++;
        if (bioRealizada) porDni[dniActual].realizadas++;
        porDni[dniActual].practicas.unshift({
          descripcion: "Práctica bioquímica",
          estado: bioRealizada ? "REALIZADA" : "AUTORIZADA",
        });
      }
    });

    const hoy = new Date();
    Object.values(porDni).forEach((a) => {
      a.diasEsperando = Math.floor(
        (hoy - new Date(a.primerIngreso)) / (1000 * 60 * 60 * 24),
      );
      a.listoParaCierre = a.total > 0 && a.realizadas === a.total;
    });

    const afiliados = Object.values(porDni).sort(
      (a, b) => b.diasEsperando - a.diasEsperando,
    );

    const listos = afiliados.filter((a) => a.listoParaCierre);
    if (listos.length > 0) {
      await supabase
        .from("derivaciones")
        .update({ estado: "LISTO_PARA_CERRAR" })
        .in(
          "dni",
          listos.map((a) => a.dni),
        )
        .eq("estado", "PENDIENTE");
    }

    // Quienes ya completaron todas las prácticas pasan a la pestaña
    // Cierre DP: no deben seguir apareciendo en Seguimiento.
    const enSeguimiento = afiliados.filter((a) => !a.listoParaCierre);

    res.json({ success: true, afiliados: enSeguimiento });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── EXCEPCIONES DE PRÁCTICAS (justificar) ──

// PV propone excepcionar una práctica puntual
app.post("/api/excepciones/proponer", async (req, res) => {
  const { dni, id_practica_autorizada, descripcion_practica, observacion, propuesta_por } =
    req.body;
  if (!dni || !id_practica_autorizada || !observacion) {
    return res
      .status(400)
      .json({ success: false, message: "Faltan datos obligatorios (DNI, práctica y observación)." });
  }
  try {
    const { error } = await supabase.from("excepciones_practicas").insert({
      dni,
      id_practica_autorizada,
      descripcion_practica,
      observacion,
      propuesta_por,
      estado: "pendiente",
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Listado de excepciones pendientes de aprobación (panel "Apto Manual")
app.get("/api/excepciones/pendientes", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("excepciones_practicas")
      .select("*")
      .eq("estado", "pendiente")
      .order("fecha_propuesta", { ascending: true });
    if (error) throw error;
    res.json({ success: true, excepciones: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Aprobar o rechazar una excepción propuesta (solo el admin/coordinador)
app.post("/api/excepciones/:id/resolver", async (req, res) => {
  const { id } = req.params;
  const { accion, aprobada_por } = req.body; // accion: 'aprobar' | 'rechazar'

  if (!["aprobar", "rechazar"].includes(accion)) {
    return res.status(400).json({ success: false, message: "Acción inválida." });
  }

  try {
    const { data: excepcion, error: errorBuscar } = await supabase
      .from("excepciones_practicas")
      .select("*")
      .eq("id", id)
      .single();
    if (errorBuscar || !excepcion) {
      return res.status(404).json({ success: false, message: "Excepción no encontrada." });
    }

    if (accion === "aprobar") {
      await supabase
        .from("practicas_autorizadas")
        .update({ estado: "EXCEPCIONADA" })
        .eq("id", excepcion.id_practica_autorizada);
    }

    await supabase
      .from("excepciones_practicas")
      .update({
        estado: accion === "aprobar" ? "aprobada" : "rechazada",
        aprobada_por,
        fecha_resolucion: new Date().toISOString(),
      })
      .eq("id", id);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── CIERRE DE OFICIO ──
app.post("/api/cierre-oficio/marcar", async (req, res) => {
  const { dni, marcado_por } = req.body;
  if (!dni) {
    return res.status(400).json({ success: false, message: "Falta el DNI." });
  }
  try {
    const { error } = await supabase.from("cierre_oficio_marcado").insert({
      dni,
      marcado_por,
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/api/contacto/:dni", async (req, res) => {
  try {
    const { data } = await supabase
      .from("contactos_afiliados")
      .select("dni, telefono, email, ciudad, actualizado_en")
      .eq("dni", req.params.dni)
      .maybeSingle();

    res.json({ success: true, contacto: data || null });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/api/contacto", async (req, res) => {
  try {
    const { dni, telefono, email, ciudad } = req.body;
    if (!dni)
      return res.status(400).json({ success: false, message: "Falta DNI." });

    const { error } = await supabase.from("contactos_afiliados").upsert(
      {
        dni,
        telefono: telefono || null,
        email: email || null,
        ciudad: ciudad || null,
        actualizado_en: new Date().toISOString(),
      },
      { onConflict: "dni" },
    );

    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/sios/pendientes", async (req, res) => {
  const { id_sede_dp, dni } = req.query;
  try {
    // Códigos que corresponden a SIOS (no los internos B/C/D de pago a profesional)
    const { data: codigosSios } = await supabase
      .from("tabla_codigos_facturacion")
      .select("codigo, descripcion")
      .eq("tipo", "SIOS");

    const catalogoPorCodigo = {};
    (codigosSios || []).forEach((c) => {
      catalogoPorCodigo[c.codigo] = c.descripcion;
    });
    const codigosSiosSet = new Set(Object.keys(catalogoPorCodigo));

    if (codigosSiosSet.size === 0) {
      return res.json({ success: true, pacientes: [] });
    }

    // Todas las filas REALIZADA con código SIOS
    let practicas = [];
    let desde = 0;
    const PAGINA = 1000;
    while (true) {
      const { data: bloque, error } = await supabase
        .from("practicas_autorizadas")
        .select(
          "id, dni, nombre_completo, descripcion_practica, codigo_prestacion, fecha_carga, nombre_prestador, cargado_sios, cargado_sios_por, fecha_carga_sios, id_sede_dp",
        )
        .eq("estado", "REALIZADA")
        .in("codigo_prestacion", Array.from(codigosSiosSet))
        .order("id", { ascending: true })
        .range(desde, desde + PAGINA - 1);

      if (error) throw error;
      if (!bloque || bloque.length === 0) break;
      practicas = practicas.concat(bloque);
      desde += PAGINA;
      if (bloque.length < PAGINA) break;
    }

    // Solo pacientes ya cerrados por el médico (Módulo Día Preventivo REALIZADA)
    const { data: cerrados } = await supabase
      .from("practicas_autorizadas")
      .select("dni")
      .eq("descripcion_practica", "Módulo Día Preventivo")
      .eq("estado", "REALIZADA");
    const dnisCerrados = new Set((cerrados || []).map((c) => c.dni));

    const porDni = {};
    practicas.forEach((p) => {
      if (!dnisCerrados.has(p.dni)) return;
      // Filtro directo por id_sede_dp de la fila (ya confiable), sin pasar
      // por tablero_dia — evita perder pacientes sin fila de ingreso ahí.
      if (id_sede_dp && p.id_sede_dp !== parseInt(id_sede_dp)) return;
      if (dni && !p.dni.includes(dni.trim())) return;

      if (!porDni[p.dni]) {
        porDni[p.dni] = {
          dni: p.dni,
          nombre: p.nombre_completo,
          codigos: [],
          pendientes: 0,
        };
      }
      if (!porDni[p.dni].nombre && p.nombre_completo)
        porDni[p.dni].nombre = p.nombre_completo;

      porDni[p.dni].codigos.push({
        id: p.id,
        codigo: p.codigo_prestacion,
        descripcion: catalogoPorCodigo[p.codigo_prestacion] || p.descripcion_practica,
        practica: p.descripcion_practica,
        prestador: p.nombre_prestador,
        fecha: p.fecha_carga,
        cargado_sios: !!p.cargado_sios,
        cargado_sios_por: p.cargado_sios_por,
        fecha_carga_sios: p.fecha_carga_sios,
      });
      if (!p.cargado_sios) porDni[p.dni].pendientes++;
    });

    const pacientes = Object.values(porDni).sort(
      (a, b) => b.pendientes - a.pendientes,
    );

    res.json({ success: true, pacientes });
  } catch (e) {
    console.error("Error en /api/sios/pendientes:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post("/api/sios/marcar", async (req, res) => {
  try {
    const { id, cargado, marcadoPor } = req.body;
    if (!id)
      return res.status(400).json({ success: false, message: "Falta id." });

    const update = cargado
      ? {
          cargado_sios: true,
          cargado_sios_por: marcadoPor || null,
          fecha_carga_sios: new Date().toISOString(),
        }
      : {
          cargado_sios: false,
          cargado_sios_por: null,
          fecha_carga_sios: null,
        };

    const { error } = await supabase
      .from("practicas_autorizadas")
      .update(update)
      .eq("id", id);

    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ==========================================
// REPORTES DE PRODUCCIÓN — helper de exportación a Excel
// ==========================================
function generarExcelBuffer(filas, columnas, nombreHoja) {
  const datosHoja = filas.map((fila) => {
    const filaOrdenada = {};
    columnas.forEach((col) => {
      filaOrdenada[col.header] = fila[col.key] ?? "";
    });
    return filaOrdenada;
  });

  const hoja = XLSX.utils.json_to_sheet(datosHoja, {
    header: columnas.map((c) => c.header),
  });

  // Ancho de columna aproximado según el contenido
  hoja["!cols"] = columnas.map((c) => ({ wch: c.width || 18 }));

  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, nombreHoja.slice(0, 31));
  return XLSX.write(libro, { type: "buffer", bookType: "xlsx" });
}

function enviarExcel(res, buffer, nombreArchivo) {
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${nombreArchivo}"`,
  );
  res.send(buffer);
}

// Trae el nombre de sede a partir de su id, para no repetir la consulta
async function obtenerMapaSedes() {
  const { data } = await supabase.from("sedes_dp").select("id, nombre, ciudad");
  const mapa = {};
  (data || []).forEach((s) => {
    mapa[s.id] = `${s.nombre} (${s.ciudad})`;
  });
  return mapa;
}

// Empareja cada dni de una lista con la sede de su visita más cercana en
// el tiempo a una fecha de referencia (sin límite de ventana temporal).
async function sedeMasCercanaPorDni(dnis, fechasRef) {
  if (dnis.length === 0) return {};
  const dnisUnicos = [...new Set(dnis)];

  let visitas = [];
  const PAGINA = 1000;
  for (let i = 0; i < dnisUnicos.length; i += 500) {
    const lote = dnisUnicos.slice(i, i + 500);
    let desde = 0;
    while (true) {
      const { data: bloque } = await supabase
        .from("tablero_dia")
        .select("dni, fecha, id_sede_dp")
        .in("dni", lote)
        .not("id_sede_dp", "is", null)
        .range(desde, desde + PAGINA - 1);
      if (!bloque || bloque.length === 0) break;
      visitas = visitas.concat(bloque);
      desde += PAGINA;
      if (bloque.length < PAGINA) break;
    }
  }

  const visitasPorDni = {};
  visitas.forEach((v) => {
    if (!visitasPorDni[v.dni]) visitasPorDni[v.dni] = [];
    visitasPorDni[v.dni].push(v);
  });

  const resultado = {};
  dnisUnicos.forEach((dni) => {
    const candidatas = visitasPorDni[dni];
    if (!candidatas || candidatas.length === 0) return;
    const fechaRef = new Date(fechasRef[dni] || Date.now());
    let mejor = candidatas[0];
    let mejorDiff = Math.abs(new Date(mejor.fecha) - fechaRef);
    candidatas.forEach((c) => {
      const diff = Math.abs(new Date(c.fecha) - fechaRef);
      if (diff < mejorDiff) {
        mejor = c;
        mejorDiff = diff;
      }
    });
    resultado[dni] = mejor.id_sede_dp;
  });
  return resultado;
}

// ==========================================
// REPORTE 1 — HOJA DE VIDA
// ==========================================
app.get("/api/reportes/hoja-de-vida", async (req, res) => {
  try {
    const { desde, hasta, id_sede_dp, dni, formato } = req.query;
    if (!desde || !hasta) {
      return res
        .status(400)
        .json({ success: false, message: "Faltan las fechas desde/hasta." });
    }

    let hojaQuery = supabase
      .from("historial_hoja_de_vida")
      .select("dni, nombre, apellido, fecha_carga, origen_carga")
      .gte("fecha_carga", desde)
      .lte("fecha_carga", `${hasta}T23:59:59`)
      .order("fecha_carga", { ascending: true });
    if (dni) hojaQuery = hojaQuery.ilike("dni", `%${dni}%`);

    let filas = [];
    let cursor = 0;
    const PAGINA = 1000;
    while (true) {
      const { data: bloque, error } = await hojaQuery.range(
        cursor,
        cursor + PAGINA - 1,
      );
      if (error) throw error;
      if (!bloque || bloque.length === 0) break;
      filas = filas.concat(bloque);
      cursor += PAGINA;
      if (bloque.length < PAGINA) break;
    }

    const fechasRef = {};
    filas.forEach((f) => {
      fechasRef[f.dni] = f.fecha_carga;
    });
    const sedePorDni = await sedeMasCercanaPorDni(
      filas.map((f) => f.dni),
      fechasRef,
    );
    const mapaSedes = await obtenerMapaSedes();

    let filasConSede = filas.map((f) => ({
      fecha_carga: f.fecha_carga,
      dni: f.dni,
      nombre: f.nombre,
      apellido: f.apellido,
      id_sede_dp: sedePorDni[f.dni] || null,
      sede: sedePorDni[f.dni] ? mapaSedes[sedePorDni[f.dni]] || "Sede desconocida" : "Sin cruzar",
      origen_carga: f.origen_carga || "",
    }));

    if (id_sede_dp) {
      filasConSede = filasConSede.filter(
        (f) => f.id_sede_dp === parseInt(id_sede_dp),
      );
    }

    const columnas = [
      { key: "fecha_carga", header: "Fecha Carga", width: 20 },
      { key: "dni", header: "DNI", width: 14 },
      { key: "apellido", header: "Apellido", width: 20 },
      { key: "nombre", header: "Nombre", width: 20 },
      { key: "sede", header: "Sede", width: 26 },
      { key: "origen_carga", header: "Origen", width: 16 },
    ];

    if (formato === "xlsx") {
      const buffer = generarExcelBuffer(filasConSede, columnas, "Hoja de Vida");
      return enviarExcel(
        res,
        buffer,
        `hoja_de_vida_${desde}_a_${hasta}.xlsx`,
      );
    }

    res.json({
      success: true,
      total: filasConSede.length,
      filas: filasConSede,
    });
  } catch (e) {
    console.error("Error en /api/reportes/hoja-de-vida:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ==========================================
// REPORTE 2 — ODONTOLOGÍA
// ==========================================
app.get("/api/reportes/odontologia", async (req, res) => {
  try {
    const { desde, hasta, id_sede_dp, dni, formato } = req.query;
    if (!desde || !hasta) {
      return res
        .status(400)
        .json({ success: false, message: "Faltan las fechas desde/hasta." });
    }

    let query = supabase
      .from("odontologia_consultas")
      .select("fecha, dni, apellido, nombre, odontologo, id_sede_dp")
      .gte("fecha", desde)
      .lte("fecha", hasta)
      .order("fecha", { ascending: true });

    if (id_sede_dp) query = query.eq("id_sede_dp", id_sede_dp);
    if (dni) query = query.ilike("dni", `%${dni}%`);

    let filas = [];
    let cursor = 0;
    const PAGINA = 1000;
    while (true) {
      const { data: bloque, error } = await query.range(
        cursor,
        cursor + PAGINA - 1,
      );
      if (error) throw error;
      if (!bloque || bloque.length === 0) break;
      filas = filas.concat(bloque);
      cursor += PAGINA;
      if (bloque.length < PAGINA) break;
    }

    const mapaSedes = await obtenerMapaSedes();
    const filasConSede = filas.map((f) => ({
      ...f,
      sede: mapaSedes[f.id_sede_dp] || "Sin sede",
    }));

    const columnas = [
      { key: "fecha", header: "Fecha", width: 16 },
      { key: "dni", header: "DNI", width: 14 },
      { key: "apellido", header: "Apellido", width: 20 },
      { key: "nombre", header: "Nombre", width: 20 },
      { key: "sede", header: "Sede", width: 26 },
      { key: "odontologo", header: "Odontólogo", width: 24 },
    ];

    if (formato === "xlsx") {
      const buffer = generarExcelBuffer(filasConSede, columnas, "Odontología");
      return enviarExcel(
        res,
        buffer,
        `odontologia_${desde}_a_${hasta}.xlsx`,
      );
    }

    res.json({ success: true, total: filasConSede.length, filas: filasConSede });
  } catch (e) {
    console.error("Error en /api/reportes/odontologia:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ==========================================
// REPORTE 3 — FORMULARIOS DE CIERRE
// ==========================================
app.get("/api/reportes/cierres", async (req, res) => {
  try {
    const { desde, hasta, id_sede_dp, dni, formato } = req.query;
    if (!desde || !hasta) {
      return res
        .status(400)
        .json({ success: false, message: "Faltan las fechas desde/hasta." });
    }

    let query = supabase
      .from("historial_dia_preventivo")
      .select("dni, apellido_y_nombre, fechax, profesional, tipo, id_sede_dp")
      .gte("fechax", desde)
      .lte("fechax", hasta)
      .order("fechax", { ascending: true });

    if (id_sede_dp) query = query.eq("id_sede_dp", id_sede_dp);
    if (dni) query = query.ilike("dni", `%${dni}%`);

    let filas = [];
    let cursor = 0;
    const PAGINA = 1000;
    while (true) {
      const { data: bloque, error } = await query.range(
        cursor,
        cursor + PAGINA - 1,
      );
      if (error) throw error;
      if (!bloque || bloque.length === 0) break;
      filas = filas.concat(bloque);
      cursor += PAGINA;
      if (bloque.length < PAGINA) break;
    }

    const mapaSedes = await obtenerMapaSedes();
    const filasConSede = filas.map((f) => ({
      ...f,
      sede: mapaSedes[f.id_sede_dp] || "Sin sede",
    }));

    const columnas = [
      { key: "fechax", header: "Fecha", width: 16 },
      { key: "dni", header: "DNI", width: 14 },
      { key: "apellido_y_nombre", header: "Apellido y Nombre", width: 28 },
      { key: "sede", header: "Sede", width: 26 },
      { key: "profesional", header: "Profesional", width: 24 },
      { key: "tipo", header: "Tipo", width: 14 },
    ];

    if (formato === "xlsx") {
      const buffer = generarExcelBuffer(
        filasConSede,
        columnas,
        "Formularios de Cierre",
      );
      return enviarExcel(res, buffer, `cierres_${desde}_a_${hasta}.xlsx`);
    }

    res.json({ success: true, total: filasConSede.length, filas: filasConSede });
  } catch (e) {
    console.error("Error en /api/reportes/cierres:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ==========================================
// REPORTE 4 — PRODUCCIÓN
// ==========================================
app.get("/api/reportes/produccion", async (req, res) => {
  try {
    const { desde, hasta, id_sede_dp, practica, dni, formato } = req.query;
    if (!desde || !hasta) {
      return res
        .status(400)
        .json({ success: false, message: "Faltan las fechas desde/hasta." });
    }

    let query = supabase
      .from("practicas_autorizadas")
      .select(
        "dni, descripcion_practica, codigo_prestacion, nombre_prestador, fecha_carga, id_sede_dp, nombre_completo",
      )
      .eq("estado", "REALIZADA")
      .gte("fecha_carga", desde)
      .lte("fecha_carga", `${hasta}T23:59:59`)
      .order("fecha_carga", { ascending: true });

    if (id_sede_dp) query = query.eq("id_sede_dp", id_sede_dp);
    if (practica) query = query.ilike("descripcion_practica", `%${practica}%`);
    if (dni) query = query.ilike("dni", `%${dni}%`);

    let filas = [];
    let cursor = 0;
    const PAGINA = 1000;
    while (true) {
      const { data: bloque, error } = await query.range(
        cursor,
        cursor + PAGINA - 1,
      );
      if (error) throw error;
      if (!bloque || bloque.length === 0) break;
      filas = filas.concat(bloque);
      cursor += PAGINA;
      if (bloque.length < PAGINA) break;
    }

    // Traer edad/sexo/contacto desde la tabla maestra de afiliados, en lotes
    const dnisUnicos = [...new Set(filas.map((f) => f.dni))];
    const datosAfiliados = {};
    for (let i = 0; i < dnisUnicos.length; i += 500) {
      const lote = dnisUnicos.slice(i, i + 500);
      const { data: bloqueAfiliados } = await supabase
        .from("afiliados")
        .select("dni, nombre, apellido, edad, sexo_biologico, telefono, email")
        .in("dni", lote);
      (bloqueAfiliados || []).forEach((a) => {
        datosAfiliados[a.dni] = a;
      });
    }

    // Menores de edad — viven en una tabla aparte, no en afiliados
    const datosMenores = {};
    for (let i = 0; i < dnisUnicos.length; i += 500) {
      const lote = dnisUnicos.slice(i, i + 500);
      const { data: bloqueMenores } = await supabase
        .from("afiliados_menores")
        .select("dni, nombre, apellido, edad, sexo_biologico, telefono, email")
        .in("dni", lote);
      (bloqueMenores || []).forEach((m) => {
        datosMenores[m.dni] = m;
      });
    }

    // Contactos editados a mano por PV (fallback si afiliados viene vacío)
    const datosContactos = {};
    for (let i = 0; i < dnisUnicos.length; i += 500) {
      const lote = dnisUnicos.slice(i, i + 500);
      const { data: bloqueContactos } = await supabase
        .from("contactos_afiliados")
        .select("dni, telefono, email")
        .in("dni", lote);
      (bloqueContactos || []).forEach((c) => {
        datosContactos[c.dni] = c;
      });
    }

    const mapaSedes = await obtenerMapaSedes();

    const filasCompletas = filas.map((f) => {
      const af = datosAfiliados[f.dni] || {};
      const men = datosMenores[f.dni] || {};
      const co = datosContactos[f.dni] || {};
      // Orden de fuentes: afiliados (adultos) -> afiliados_menores (chicos)
      // -> nombre_completo ya guardado en la propia fila (último recurso,
      // va entero en Apellido porque no se puede separar con certeza).
      const tieneNombreAfiliado = af.apellido || af.nombre;
      const tieneNombreMenor = !tieneNombreAfiliado && (men.apellido || men.nombre);
      return {
        fecha_carga: f.fecha_carga,
        dni: f.dni,
        apellido: tieneNombreAfiliado
          ? af.apellido || ""
          : tieneNombreMenor
            ? men.apellido || ""
            : f.nombre_completo || "",
        nombre: tieneNombreAfiliado
          ? af.nombre || ""
          : tieneNombreMenor
            ? men.nombre || ""
            : "",
        edad: af.edad || men.edad || "",
        sexo: af.sexo_biologico || men.sexo_biologico || "",
        telefono: af.telefono || men.telefono || co.telefono || "",
        email: af.email || men.email || co.email || "",
        codigo_prestacion: f.codigo_prestacion || "",
        descripcion_practica:
          f.descripcion_practica === "Telereceta"
            ? "Telecuidado"
            : f.descripcion_practica,
        prestador: f.nombre_prestador || "",
        sede: mapaSedes[f.id_sede_dp] || "Sin sede",
      };
    });

    // Resúmenes por tipo de evento administrativo (mismas descripciones
    // exactas que usa el resto del sistema)
    const contarPor = (desc) =>
      filas.filter((f) => f.descripcion_practica === desc).length;

    const resumen = {
      totalFilas: filasCompletas.length,
      cierresDP: contarPor("Módulo Día Preventivo"),
      extramodulos: contarPor("Módulo Extramódulo"),
      seguimientos: contarPor("Módulo Seguimiento"),
      telereceta: contarPor("Telereceta"),
    };

    const columnas = [
      { key: "fecha_carga", header: "Fecha Práctica", width: 20 },
      { key: "dni", header: "DNI", width: 14 },
      { key: "apellido", header: "Apellido", width: 20 },
      { key: "nombre", header: "Nombre", width: 20 },
      { key: "edad", header: "Edad", width: 8 },
      { key: "sexo", header: "Sexo", width: 12 },
      { key: "telefono", header: "Teléfono", width: 16 },
      { key: "email", header: "Email", width: 24 },
      { key: "codigo_prestacion", header: "Código Prestación", width: 18 },
      { key: "descripcion_practica", header: "Descripción Prestación", width: 34 },
      { key: "prestador", header: "Prestador", width: 26 },
      { key: "sede", header: "Sede", width: 26 },
    ];

    if (formato === "xlsx") {
      const buffer = generarExcelBuffer(
        filasCompletas,
        columnas,
        "Producción",
      );
      return enviarExcel(res, buffer, `produccion_${desde}_a_${hasta}.xlsx`);
    }

    res.json({ success: true, resumen, filas: filasCompletas });
  } catch (e) {
    console.error("Error en /api/reportes/produccion:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/reportes/practicas-distintas", async (req, res) => {
  try {
    let practicas = [];
    let cursor = 0;
    const PAGINA = 1000;
    while (true) {
      const { data: bloque, error } = await supabase
        .from("practicas_autorizadas")
        .select("descripcion_practica")
        .range(cursor, cursor + PAGINA - 1);
      if (error) throw error;
      if (!bloque || bloque.length === 0) break;
      practicas = practicas.concat(bloque.map((b) => b.descripcion_practica));
      cursor += PAGINA;
      if (bloque.length < PAGINA) break;
    }

    const distintas = [...new Set(practicas)].filter(Boolean).sort();
    res.json({ success: true, practicas: distintas });
  } catch (e) {
    console.error("Error en /api/reportes/practicas-distintas:", e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post(
  "/api/sios/importar-excel",
  upload.single("archivo"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "No se recibió ningún archivo." });
      }

      const { mesReferencia, marcadoPor } = req.body;
      if (!mesReferencia) {
        return res.status(400).json({
          success: false,
          message: "Falta el mes de referencia (formato YYYY-MM).",
        });
      }

      // ── Leer el Excel y encontrar la fila de encabezado real ──
      // El archivo de SIOS trae 2-3 filas de título/estado antes del
      // encabezado real ("Número Consumo", "Afiliado", "Práctica", ...).
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const hoja = workbook.Sheets[workbook.SheetNames[0]];
      const filasCrudas = XLSX.utils.sheet_to_json(hoja, { header: 1 });

      let indiceEncabezado = -1;
      let colAfiliado = -1;
      let colPractica = -1;
      let colDescripcion = -1;

      for (let i = 0; i < Math.min(filasCrudas.length, 10); i++) {
        const fila = filasCrudas[i].map((c) =>
          (c || "").toString().trim().toLowerCase(),
        );
        const idxAfiliado = fila.indexOf("afiliado");
        const idxPractica = fila.indexOf("práctica");
        if (idxAfiliado !== -1 && idxPractica !== -1) {
          indiceEncabezado = i;
          colAfiliado = idxAfiliado;
          colPractica = idxPractica;
          colDescripcion = fila.indexOf("descripción");
          break;
        }
      }

      if (indiceEncabezado === -1) {
        return res.status(400).json({
          success: false,
          message:
            'No se encontró la fila de encabezado (se esperaban columnas "Afiliado" y "Práctica"). Verificá el formato del archivo.',
        });
      }

      // Algunos códigos SIOS (siempre numéricos) corresponden a un código
      // interno distinto en nuestro sistema (con letra), porque para
      // nosotros ese mismo evento se guarda bajo otro identificador para
      // calcular el pago al profesional. Ej: SIOS "339150 TELECUIDADOS"
      // corresponde a nuestro interno "339150R" (Telereceta).
      const MAPEO_CODIGOS_SIOS_A_INTERNO = {
        339150: "339150R",
      };

      // Códigos que SIOS factura como renglón aparte de otra práctica
      // (insumos/materiales asociados), pero que nuestro sistema nunca
      // registra como fila propia — se consideran "resueltos" si el
      // código principal asociado ya está REALIZADA para el mismo DNI,
      // en vez de reportarse siempre como sin coincidencia.
      const CODIGOS_ASOCIADOS = {
        431052: "205011", // Medicamentos anestésicos/descartables -> VCC
        169020: "205011", // Anestesia Nivel 3 -> VCC
      };

      // Códigos donde SIOS factura UN solo renglón, pero nuestro sistema
      // genera varias filas separadas para el mismo estudio (ej. HPV
      // guarda genotipo 16 / 18 / otros como 3 filas, todas con
      // 679912) — un solo match del Excel marca TODAS las filas de ese
      // dni+código de una vez, no solo una.
      const CODIGOS_MULTIFILA = new Set(["679912"]);

      // Códigos que el laboratorio siempre incluye en el "paquete" de
      // estudios (desde los 18 años), sin importar si nuestro algoritmo
      // de recomendaciones lo autorizó puntualmente para ese paciente
      // (ej. creatinina se autoriza recién a partir de los 40, pero el
      // laboratorio la hace igual desde más joven). Cuando SIOS factura
      // uno de estos códigos y no existe NINGUNA fila para ese dni, se
      // crea directamente como REALIZADA — se confía en que se hizo,
      // ya que SIOS no factura estudios que no se realizaron.
      // Según el protocolo de Bioquímica ("Módulo Adulto"), estas
      // prácticas se hacen SIEMPRE en cualquier adulto (16+) que pase
      // por el Día Preventivo, sin depender de que nuestro algoritmo de
      // recomendaciones la haya autorizado puntualmente para ese
      // paciente. No incluye las condicionadas (SOMF, HPV, PSA — esas
      // sí dependen de edad/sexo/antecedente real) ni las de Seguimiento
      // de Crónicos (Hb A1C, Proteinuria, Microalbuminuria, Clearence).
      const CODIGOS_SIEMPRE_EN_PAQUETE_LAB = {
        679902: "colesterol total",
        679907: "HDL/colesterol",
        679913: "LDL/colesterol",
        679906: "trigliceridos",
        679904: "glucemia en ayunas",
        679903: "creatinina",
        679901: "anticuerpos anti_VIH",
        679909: "hepatitis b antigeno de superficie_AGHB",
        679910: "hepatitis c _HCV_AC_IGG",
        679918: "VDRL",
        679917: "test chagas HAI",
        679923: "test chagas ECLIA",
      };

      const filasDatos = filasCrudas
        .slice(indiceEncabezado + 1)
        .filter((f) => f[colAfiliado] && f[colPractica])
        .map((f) => {
          const codigoSios = f[colPractica].toString().trim();
          return {
            dni: f[colAfiliado].toString().trim(),
            codigoSios,
            codigo: MAPEO_CODIGOS_SIOS_A_INTERNO[codigoSios] || codigoSios,
            descripcion: colDescripcion !== -1 ? f[colDescripcion] : "",
          };
        });

      if (filasDatos.length === 0) {
        return res.json({
          success: true,
          totalFilasExcel: 0,
          coincidencias: 0,
          sinCoincidencia: 0,
        });
      }

      // Edad de cada DNI del Excel — el "paquete siempre incluido" del
      // laboratorio solo se auto-crea para adultos (16+); en menores la
      // extracción de sangre depende de que el médico la indique
      // puntualmente, así que no se debe asumir.
      const dnisDelExcel = [...new Set(filasDatos.map((f) => f.dni))];
      const edadPorDniImport = {};
      for (let i = 0; i < dnisDelExcel.length; i += 500) {
        const lote = dnisDelExcel.slice(i, i + 500);
        const { data: bloqueAdultosImport } = await supabase
          .from("afiliados")
          .select("dni, edad")
          .in("dni", lote);
        (bloqueAdultosImport || []).forEach((a) => {
          edadPorDniImport[a.dni] = a.edad;
        });
        const { data: bloqueMenoresImport } = await supabase
          .from("afiliados_menores")
          .select("dni, edad")
          .in("dni", lote);
        (bloqueMenoresImport || []).forEach((m) => {
          edadPorDniImport[m.dni] = m.edad;
        });
      }
      const dnisSinEdadImport = dnisDelExcel.filter(
        (d) => edadPorDniImport[d] === undefined,
      );
      for (let i = 0; i < dnisSinEdadImport.length; i += 500) {
        const lote = dnisSinEdadImport.slice(i, i + 500);
        const { data: bloqueTableroImport } = await supabase
          .from("tablero_dia")
          .select("dni, edad")
          .in("dni", lote)
          .not("edad", "is", null);
        (bloqueTableroImport || []).forEach((t) => {
          if (edadPorDniImport[t.dni] === undefined)
            edadPorDniImport[t.dni] = t.edad;
        });
      }

      // ── Traer de la base TODO lo REALIZADA, sin restringir por fecha ──
      // SIOS puede facturar con semanas o meses de atraso, así que un
      // Excel de "agosto" puede traer prácticas que en nuestro sistema
      // quedaron con fecha_carga de julio o antes — restringir la
      // búsqueda al mes de referencia dejaba afuera esos casos legítimos.
      // "mesReferencia" ahora solo se usa para el registro/auditoría de
      // la importación, no para filtrar qué se busca.
      //
      // Se buscan tanto REALIZADA como AUTORIZADA: si SIOS ya facturó
      // una práctica que en nuestro sistema sigue "autorizada" (nunca se
      // marcó como hecha), se confía en SIOS — no factura estudios que
      // no se hicieron — y se confirma automáticamente como REALIZADA
      // al mismo tiempo que se marca cargado_sios.
      let candidatas = [];
      let cursor = 0;
      const PAGINA = 1000;
      while (true) {
        const { data: bloque, error } = await supabase
          .from("practicas_autorizadas")
          .select("id, dni, codigo_prestacion, cargado_sios, estado")
          .in("estado", ["REALIZADA", "AUTORIZADA"])
          .not("codigo_prestacion", "is", null)
          .range(cursor, cursor + PAGINA - 1);
        if (error) throw error;
        if (!bloque || bloque.length === 0) break;
        candidatas = candidatas.concat(bloque);
        cursor += PAGINA;
        if (bloque.length < PAGINA) break;
      }

      // Mapa dni+codigo -> lista de ids candidatos (puede haber más de una
      // fila para el mismo par si se repitió la práctica en el mes).
      // Se limpia el DNI y el código con .trim() de este lado también —
      // no alcanza con limpiar solo el Excel, porque hay filas viejas en
      // la base que quedaron con espacios de más (de antes de que
      // arregláramos varios formularios de carga).
      const mapaCandidatas = {};
      candidatas.forEach((c) => {
        const dniLimpio = (c.dni || "").toString().trim();
        const codigoLimpio = (c.codigo_prestacion || "").toString().trim();
        const clave = `${dniLimpio}_${codigoLimpio}`;
        if (!mapaCandidatas[clave]) mapaCandidatas[clave] = [];
        mapaCandidatas[clave].push(c);
      });

      const idsAMarcarSoloSios = []; // ya estaban REALIZADA, solo falta cargado_sios
      const idsAConfirmarRealizada = []; // estaban AUTORIZADA, SIOS confirma que se hicieron
      const sinCoincidenciaEjemplos = [];
      const indicePorClave = {};
      let coincidenciasTotal = 0;
      let yaEstabanMarcadas = 0;
      let coincidenciasAsociadas = 0;
      let marcadosExcelNivel = 0; // cuenta por renglón de Excel, no por fila de base
      let confirmadasComoRealizadas = 0; // cuántas pasaron de AUTORIZADA a REALIZADA
      const filasACrear = []; // nuevas, nunca existieron, SIOS confirma que se hicieron
      let creadasNuevas = 0;

      filasDatos.forEach((f) => {
        const clave = `${f.dni}_${f.codigo}`;
        const candidatasClave = mapaCandidatas[clave];

        if (!candidatasClave || candidatasClave.length === 0) {
          // ¿Es un código que sabemos que va asociado a otra práctica
          // (insumos/materiales), sin fila propia? Si el código principal
          // ya está resuelto para el mismo DNI, se cuenta como asociado,
          // no como sin coincidencia.
          const codigoPrincipal = CODIGOS_ASOCIADOS[f.codigo];
          if (codigoPrincipal) {
            const clavePrincipal = `${f.dni}_${codigoPrincipal}`;
            if (mapaCandidatas[clavePrincipal]?.length > 0) {
              coincidenciasAsociadas++;
              return;
            }
          }

          // ¿Es un código que el laboratorio siempre hace en el paquete,
          // aunque nuestro algoritmo no lo haya autorizado puntualmente?
          // Se crea directamente como REALIZADA, sin pasar por AUTORIZADA
          // — pero solo para adultos (16+): en menores, la extracción de
          // sangre depende de que el médico la indique puntualmente.
          const descripcionPaquete = CODIGOS_SIEMPRE_EN_PAQUETE_LAB[f.codigo];
          const edadDelDni = edadPorDniImport[f.dni];
          const esAdultoConfirmado =
            edadDelDni !== undefined && edadDelDni !== null && edadDelDni >= 16;
          if (descripcionPaquete && esAdultoConfirmado && !indicePorClave[clave]) {
            filasACrear.push({ dni: f.dni, codigo: f.codigo, descripcion: descripcionPaquete });
            creadasNuevas++;
            indicePorClave[clave] = 1;
            return;
          }
          if (descripcionPaquete && esAdultoConfirmado) return; // duplicado, ya se creó arriba

          if (sinCoincidenciaEjemplos.length < 30) {
            sinCoincidenciaEjemplos.push(f);
          }
          return;
        }

        // Códigos "multi-fila": un solo renglón de SIOS marca TODAS las
        // filas candidatas de ese dni+código de una vez (ej. HPV, que
        // nosotros guardamos como 3 filas separadas). Se cuenta como UN
        // renglón de Excel (no como 3), para que los totales del reporte
        // sigan siendo consistentes entre sí.
        if (CODIGOS_MULTIFILA.has(f.codigo) && !indicePorClave[clave]) {
          coincidenciasTotal++;
          const algunaSinMarcar = candidatasClave.some((c) => !c.cargado_sios);
          candidatasClave.forEach((c) => {
            if (!c.cargado_sios) {
              if (c.estado === "AUTORIZADA") {
                idsAConfirmarRealizada.push(c.id);
                confirmadasComoRealizadas++;
              } else {
                idsAMarcarSoloSios.push(c.id);
              }
            }
          });
          if (algunaSinMarcar) {
            marcadosExcelNivel++;
          } else {
            yaEstabanMarcadas++;
          }
          indicePorClave[clave] = candidatasClave.length; // ya se resolvió del todo
          return;
        }

        // Cada fila del Excel con el mismo dni+código consume una fila
        // candidata distinta de la base (por si el mismo par se repitió
        // más de una vez en el mes), sin marcar la misma fila dos veces.
        const idx = indicePorClave[clave] || 0;
        const candidata = candidatasClave[idx];

        if (candidata) {
          coincidenciasTotal++;
          if (!candidata.cargado_sios) {
            if (candidata.estado === "AUTORIZADA") {
              idsAConfirmarRealizada.push(candidata.id);
              confirmadasComoRealizadas++;
            } else {
              idsAMarcarSoloSios.push(candidata.id);
            }
            marcadosExcelNivel++;
          } else {
            yaEstabanMarcadas++;
          }
          indicePorClave[clave] = idx + 1;
        } else if (sinCoincidenciaEjemplos.length < 30) {
          sinCoincidenciaEjemplos.push(f);
        }
      });

      // ── Marcar en bloques (evitar mandar 20.000 ids en un solo UPDATE) ──
      const LOTE = 300;

      for (let i = 0; i < idsAMarcarSoloSios.length; i += LOTE) {
        const lote = idsAMarcarSoloSios.slice(i, i + LOTE);
        const { error: errorUpdate } = await supabase
          .from("practicas_autorizadas")
          .update({
            cargado_sios: true,
            cargado_sios_por: marcadoPor
              ? `${marcadoPor} (importación Excel SIOS)`
              : "Importación Excel SIOS",
            fecha_carga_sios: new Date().toISOString(),
          })
          .in("id", lote);
        if (errorUpdate) throw errorUpdate;
      }

      // Estas venían en AUTORIZADA — SIOS ya las facturó, así que se
      // confirman como REALIZADA al mismo tiempo que se marcan cargadas.
      for (let i = 0; i < idsAConfirmarRealizada.length; i += LOTE) {
        const lote = idsAConfirmarRealizada.slice(i, i + LOTE);
        const { error: errorUpdate } = await supabase
          .from("practicas_autorizadas")
          .update({
            estado: "REALIZADA",
            cargado_sios: true,
            cargado_sios_por: marcadoPor
              ? `${marcadoPor} (confirmado vía importación Excel SIOS)`
              : "Confirmado vía importación Excel SIOS",
            fecha_carga_sios: new Date().toISOString(),
          })
          .in("id", lote);
        if (errorUpdate) throw errorUpdate;
      }

      // Crear de cero las que nunca existieron pero SIOS confirma que se
      // hicieron (ej. creatinina en menores de 40, que el laboratorio
      // hace igual aunque nuestro algoritmo no la autorice para esa edad).
      for (let i = 0; i < filasACrear.length; i += LOTE) {
        const lote = filasACrear.slice(i, i + LOTE);
        const { error: errorInsert } = await supabase
          .from("practicas_autorizadas")
          .insert(
            lote.map((f) => ({
              dni: f.dni,
              descripcion_practica: f.descripcion,
              codigo_prestacion: f.codigo,
              estado: "REALIZADA",
              cargado_sios: true,
              cargado_sios_por: marcadoPor
                ? `${marcadoPor} (creada vía importación Excel SIOS)`
                : "Creada vía importación Excel SIOS",
              fecha_carga_sios: new Date().toISOString(),
            })),
          );
        if (errorInsert) throw errorInsert;
      }

      res.json({
        success: true,
        totalFilasExcel: filasDatos.length,
        coincidencias: coincidenciasTotal,
        marcadasEnEstaCorrida: marcadosExcelNivel,
        confirmadasComoRealizadas,
        creadasNuevas,
        yaEstabanMarcadas,
        coincidenciasAsociadas,
        sinCoincidencia:
          filasDatos.length -
          coincidenciasTotal -
          coincidenciasAsociadas -
          creadasNuevas,
        ejemplosSinCoincidencia: sinCoincidenciaEjemplos,
      });
    } catch (e) {
      console.error("Error en /api/sios/importar-excel:", e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

// ==========================================
// PANEL DE COORDINADORES — seguimiento de poblaciones específicas
// (Ministerio de Salud, Policía, Docentes, etc.)
// Protegido con la misma ADMIN_KEY que PPDT-Auth.
// ==========================================
function requiereAdminKey(req, res, next) {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ success: false, message: "No autorizado." });
  }
  next();
}

// ── Importar/reemplazar una nómina completa ──
app.post(
  "/api/coordinadores/nominas/importar",
  requiereAdminKey,
  upload.single("archivo"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "No se recibió ningún archivo." });
      }
      const { poblacion, cargadoPor } = req.body;
      if (!poblacion) {
        return res
          .status(400)
          .json({ success: false, message: "Falta indicar la población." });
      }

      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const hoja = workbook.Sheets[workbook.SheetNames[0]];
      const filas = XLSX.utils.sheet_to_json(hoja, { header: 1 });

      // Buscar la fila de encabezado real (DOCUMENTO / APELLIDO / NOMBRE)
      let indiceEncabezado = -1;
      let colDoc = -1;
      let colApellido = -1;
      let colNombre = -1;
      for (let i = 0; i < Math.min(filas.length, 10); i++) {
        const fila = filas[i].map((c) => (c || "").toString().trim().toLowerCase());
        const idxDoc = fila.findIndex((c) => c.includes("documento") || c === "dni");
        const idxApellido = fila.indexOf("apellido");
        const idxNombre = fila.indexOf("nombre");
        if (idxDoc !== -1 && idxApellido !== -1) {
          indiceEncabezado = i;
          colDoc = idxDoc;
          colApellido = idxApellido;
          colNombre = idxNombre;
          break;
        }
      }

      if (indiceEncabezado === -1) {
        return res.status(400).json({
          success: false,
          message:
            'No se encontró la fila de encabezado (se esperaban columnas "DOCUMENTO" y "APELLIDO").',
        });
      }

      const filasNomina = filas
        .slice(indiceEncabezado + 1)
        .filter((f) => f[colDoc])
        .map((f) => ({
          poblacion,
          // El DNI en estas planillas suele venir con puntos de miles
          // (ej. "11.676.563") — se limpian antes de guardar.
          dni: f[colDoc].toString().replace(/\D/g, "").trim(),
          apellido: colApellido !== -1 ? (f[colApellido] || "").toString().trim() : "",
          nombre: colNombre !== -1 ? (f[colNombre] || "").toString().trim() : "",
          activo: true,
          cargado_por: cargadoPor || "Coordinador",
        }))
        .filter((f) => f.dni.length >= 6);

      if (filasNomina.length === 0) {
        return res.json({
          success: true,
          totalFilas: 0,
          message: "El archivo no tenía filas válidas para cargar.",
        });
      }

      // Reemplazar: la nómina vieja de esta población se marca inactiva
      // (no se borra, queda en la base con su fecha original), y se
      // inserta la nueva como vigente.
      await supabase
        .from("nominas_poblaciones")
        .update({ activo: false })
        .eq("poblacion", poblacion)
        .eq("activo", true);

      const LOTE = 500;
      let insertadas = 0;
      for (let i = 0; i < filasNomina.length; i += LOTE) {
        const lote = filasNomina.slice(i, i + LOTE);
        const { error } = await supabase.from("nominas_poblaciones").insert(lote);
        if (error) throw error;
        insertadas += lote.length;
      }

      res.json({ success: true, totalFilas: insertadas });
    } catch (e) {
      console.error("Error en /api/coordinadores/nominas/importar:", e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

// ── Resumen por población (cuántos hicieron / faltan) ──
app.get(
  "/api/coordinadores/nominas/lista-poblaciones",
  requiereAdminKey,
  async (req, res) => {
    try {
      const { data } = await supabase
        .from("nominas_poblaciones")
        .select("poblacion")
        .eq("activo", true);
      const poblaciones = [...new Set((data || []).map((p) => p.poblacion))].sort();
      res.json({ success: true, poblaciones });
    } catch (e) {
      console.error("Error en /api/coordinadores/nominas/lista-poblaciones:", e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

app.get(
  "/api/coordinadores/nominas/resumen",
  requiereAdminKey,
  async (req, res) => {
    try {
      const { poblacion: poblacionFiltro } = req.query;
      let query = supabase
        .from("nominas_poblaciones")
        .select("poblacion")
        .eq("activo", true);
      if (poblacionFiltro) query = query.eq("poblacion", poblacionFiltro);
      const { data: poblacionesData } = await query;

      const poblaciones = [...new Set((poblacionesData || []).map((p) => p.poblacion))];

      const resumen = [];
      for (const poblacion of poblaciones) {
        const { data: nomina } = await supabase
          .from("nominas_poblaciones")
          .select("dni")
          .eq("poblacion", poblacion)
          .eq("activo", true);

        const dnis = [...new Set((nomina || []).map((n) => n.dni))];
        let dnisConDP = new Set();

        for (let i = 0; i < dnis.length; i += 500) {
          const lote = dnis.slice(i, i + 500);
          const { data: cierres } = await supabase
            .from("historial_dia_preventivo")
            .select("dni")
            .in("dni", lote);
          (cierres || []).forEach((c) => dnisConDP.add(c.dni));

          // Respaldo: casos donde el registro clínico no quedó, pero sí
          // existe la facturación del módulo (o viceversa) — cuenta con
          // que aparezca en cualquiera de las dos fuentes.
          const { data: modulos } = await supabase
            .from("practicas_autorizadas")
            .select("dni")
            .eq("descripcion_practica", "Módulo Día Preventivo")
            .eq("estado", "REALIZADA")
            .in("dni", lote);
          (modulos || []).forEach((m) => dnisConDP.add(m.dni));
        }

        resumen.push({
          poblacion,
          total: dnis.length,
          hicieron: dnisConDP.size,
          faltan: dnis.length - dnisConDP.size,
        });
      }

      res.json({ success: true, resumen });
    } catch (e) {
      console.error("Error en /api/coordinadores/nominas/resumen:", e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

// ── Detalle de una población (quiénes hicieron y quiénes faltan) ──
app.get(
  "/api/coordinadores/nominas/detalle",
  requiereAdminKey,
  async (req, res) => {
    try {
      const { poblacion, formato } = req.query;
      if (!poblacion) {
        return res
          .status(400)
          .json({ success: false, message: "Falta indicar la población." });
      }

      const { data: nomina } = await supabase
        .from("nominas_poblaciones")
        .select("dni, apellido, nombre")
        .eq("poblacion", poblacion)
        .eq("activo", true);

      const dnis = [...new Set((nomina || []).map((n) => n.dni))];
      const modulosPorDni = {};

      const agregarFecha = (dni, fecha) => {
        if (!fecha) return;
        const fechaSolo = fecha.toString().split("T")[0];
        if (!modulosPorDni[dni]) modulosPorDni[dni] = new Set();
        modulosPorDni[dni].add(fechaSolo);
      };

      for (let i = 0; i < dnis.length; i += 500) {
        const lote = dnis.slice(i, i + 500);
        const { data: cierres } = await supabase
          .from("historial_dia_preventivo")
          .select("dni, fechax")
          .in("dni", lote)
          .order("fechax", { ascending: true });
        (cierres || []).forEach((c) => agregarFecha(c.dni, c.fechax));

        // Respaldo: casos donde el registro clínico no quedó, pero sí
        // existe la facturación del módulo — mismo criterio que en el
        // resumen, cuenta con aparecer en cualquiera de las dos fuentes.
        const { data: modulos } = await supabase
          .from("practicas_autorizadas")
          .select("dni, fecha_carga")
          .eq("descripcion_practica", "Módulo Día Preventivo")
          .eq("estado", "REALIZADA")
          .in("dni", lote);
        (modulos || []).forEach((m) => agregarFecha(m.dni, m.fecha_carga));
      }

      const filas = nomina.map((n) => {
        const fechas = [...(modulosPorDni[n.dni] || new Set())].sort();
        return {
          dni: n.dni,
          apellido: n.apellido,
          nombre: n.nombre,
          cantidad_dp: fechas.length,
          fechas: fechas
            .map((f) => (f ? new Date(f).toLocaleDateString("es-AR") : ""))
            .join(", "),
          estado: fechas.length > 0 ? "Hizo el DP" : "Falta",
        };
      });

      const columnas = [
        { key: "dni", header: "DNI", width: 14 },
        { key: "apellido", header: "Apellido", width: 20 },
        { key: "nombre", header: "Nombre", width: 20 },
        { key: "estado", header: "Estado", width: 14 },
        { key: "cantidad_dp", header: "Cantidad DP", width: 12 },
        { key: "fechas", header: "Fechas", width: 30 },
      ];

      if (formato === "xlsx") {
        const buffer = generarExcelBuffer(
          filas,
          columnas,
          poblacion.slice(0, 28),
        );
        return enviarExcel(
          res,
          buffer,
          `${poblacion.replace(/\s+/g, "_")}.xlsx`,
        );
      }

      res.json({ success: true, filas });
    } catch (e) {
      console.error("Error en /api/coordinadores/nominas/detalle:", e.message);
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

app.listen(PORT, () => {
  console.log(`CRM Preventivistas corriendo en http://localhost:${PORT}`);
});