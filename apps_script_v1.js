// =================================================================
// CONFIGURACIÓN GLOBAL
// =================================================================
const CALENDAR_NAME = "Turnos Día Preventivo - IAPOS";
const SHEET_NAME = "turnos";
const HORA_INICIO = 7;
const MINUTO_INICIO = 30;
const HORA_FIN = 11;
const MINUTO_FIN = 0;
const DURACION_TURNO = 10;
const DIAS_A_GENERAR = 60;

// =================================================================
// FUNCIÓN MANUAL PARA REGENERAR LA TURNERA
// =================================================================
function regenerarTodaLaTurnera() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  Browser.msgBox("Iniciando la regeneración de la lista de turnos...");
  let calendar = CalendarApp.getCalendarsByName(CALENDAR_NAME)[0];
  if (calendar) {
    calendar.deleteCalendar();
    Utilities.sleep(3000); 
  }
  calendar = CalendarApp.createCalendar(CALENDAR_NAME);
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  }
  const hoy = new Date();
  const turnosParaHoja = [];
  let idTurnoCounter = 1;
  for (let i = 0; i < DIAS_A_GENERAR; i++) {
    let diaActual = new Date();
    diaActual.setDate(hoy.getDate() + i);
    if (diaActual.getDay() >= 1 && diaActual.getDay() <= 5) {
      let inicioTurno = new Date(diaActual.setHours(HORA_INICIO, MINUTO_INICIO, 0, 0));
      let finJornada = new Date(diaActual.setHours(HORA_FIN, MINUTO_FIN, 0, 0));
      while (inicioTurno.getTime() < finJornada.getTime()) {
        let finTurno = new Date(inicioTurno.getTime() + DURACION_TURNO * 60 * 1000);
        turnosParaHoja.push([
          idTurnoCounter, inicioTurno, finTurno, "Disponible",
          '', '', '', '', '', ''
        ]);
        idTurnoCounter++;
        inicioTurno = finTurno;
      }
    }
  }
  if (turnosParaHoja.length > 0) {
    sheet.getRange(2, 1, turnosParaHoja.length, 10).setValues(turnosParaHoja);
  }
  Browser.msgBox(`¡Regeneración completa! Se crearon ${turnosParaHoja.length} espacios de turno.`);
}

// =================================================================
// FUNCIONES PARA LA APP WEB (WEBHOOK)
// =================================================================
function doPost(e) {
  const params = JSON.parse(e.postData.contents);
  const action = params.action;
  let result = {};
  try {
    switch (action) {
      case 'getNextAvailable': result = getNextAvailableSlots(); break;
      case 'bookAppointment': result = bookAppointment(params.slotId, params.userInfo); break;
      case 'cancelAppointment': result = cancelAppointment(params.eventId); break;
      case 'getAllAppointments': result = getAllAppointments(); break;
      case 'getUserDataByDNI': result = getUserDataByDNI(params.dni); break;
      default: result = { status: 'error', message: 'Acción no reconocida' };
    }
  } catch (err) {
    result = { status: 'error', message: 'Error en el servidor de Google: ' + err.toString() };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function getNextAvailableSlots() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (sheet.getLastRow() < 2) return { status: 'success', slots: [] };
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
  const availableSlots = [];
  const now = new Date();
  for (let row of data) {
    if (row[0] && row[1] && row[3] === 'Disponible' && new Date(row[1]) > now) {
      availableSlots.push({ id: row[0], time: new Date(row[1]).toISOString() });
    }
  }
  return { status: 'success', slots: availableSlots };
}

function bookAppointment(slotId, userInfo) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const data = sheet.getRange(2, 1, sheet.getLastRow(), 10).getValues();
  const calendar = CalendarApp.getCalendarsByName(CALENDAR_NAME)[0];
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] == slotId && data[i][3] === 'Disponible') {
      const rowNumber = i + 2;
      const nombreCompleto = `${userInfo.nombre} ${userInfo.apellido}`;
      const fechaInicio = new Date(data[i][1]);
      const fechaFin = new Date(data[i][2]);
      const evento = calendar.createEvent(`Turno: ${nombreCompleto}`, fechaInicio, fechaFin, {
        description: `DNI: ${userInfo.dni}\nContacto: ${userInfo.whatsapp}`
      });
      const eventId = evento.getId();
      sheet.getRange(rowNumber, 4).setValue('Confirmado');
      sheet.getRange(rowNumber, 5).setValue(userInfo.apellido);
      sheet.getRange(rowNumber, 6).setValue(userInfo.nombre);
      sheet.getRange(rowNumber, 7).setValue(userInfo.dni);
      sheet.getRange(rowNumber, 8).setValue(userInfo.email);
      sheet.getRange(rowNumber, 9).setValue(userInfo.whatsapp);
      sheet.getRange(rowNumber, 10).setValue(eventId);
      if (userInfo.email) {
        const turnoFecha = fechaInicio.toLocaleString('es-AR', { dateStyle: 'full', timeStyle: 'short' });
        const urlCancelacion = `https://turnera-iapos-web.onrender.com/cancelar.html?id=${encodeURIComponent(eventId)}`;
        const asunto = "Confirmación e Instrucciones para tu turno - Día Preventivo IAPOS";
        const cuerpo = `Hola ${userInfo.nombre},\n\nTu turno para el Día Preventivo de IAPOS ha sido confirmado:\n\nFecha y Hora: ${turnoFecha}\n\n----------------------------------------------------\nINSTRUCCIONES IMPORTANTES PARA TU TURNO:\n----------------------------------------------------\n- Es muy importante que venga en AYUNO de al menos 12hs.\n- Si es FUMADOR/A, NO debe fumar al menos una hora previa al turno.\n- Si utiliza lentes, debe TRAERLOS ese día.\n\n- Dirección: San Martín 3145, Santa Fe, Capital\n- WhatsApp de Contacto: 342 4068756\n----------------------------------------------------\n\nSi necesitas cancelar, usa este enlace:\n${urlCancelacion}\n\n¡Te esperamos!`;
        GmailApp.sendEmail(userInfo.email, asunto, cuerpo, { name: 'IAPOS Día Preventivo' });
      }
      return { status: 'success', message: 'Turno confirmado con éxito.' };
    }
  }
  return { status: 'error', message: 'El turno ya no está disponible.' };
}

function getAllAppointments() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (sheet.getLastRow() < 2) return { status: 'success', appointments: [] };
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  const appointments = [];
  for (let row of data) {
    if (row[3] === 'Confirmado') {
      appointments.push({
        idTurno: row[0], fechaInicio: new Date(row[1]).toISOString(), apellido: row[4], nombre: row[5],
        dni: row[6], email: row[7], telefono: row[8], idEvento: row[9]
      });
    }
  }
  appointments.sort((a, b) => new Date(a.fechaInicio) - new Date(b.fechaInicio)); // Ordenar del más antiguo al más nuevo
  return { status: 'success', appointments: appointments };
}

function getUserDataByDNI(dni) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (sheet.getLastRow() < 2) return { status: 'not_found' };
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  let userData = null;
  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    if (row[6] && row[6].toString().trim() === dni.toString().trim()) {
      userData = { apellido: row[4], nombre: row[5], email: row[7], telefono: row[8] };
      break;
    }
  }
  if (userData) {
    return { status: 'success', data: userData };
  } else {
    return { status: 'not_found', message: 'No se encontraron datos para ese DNI.' };
  }
}

function cancelAppointment(eventId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const data = sheet.getRange(2, 1, sheet.getLastRow(), 10).getValues();
  const calendar = CalendarApp.getCalendarsByName(CALENDAR_NAME)[0];
  for (let i = 0; i < data.length; i++) {
    if (data[i][9] == eventId) {
      const rowNumber = i + 2;
      try {
        if (calendar) {
          const event = calendar.getEventById(eventId);
          if (event) event.deleteEvent();
        }
      } catch(e) { /* Ignorar error */ }
      sheet.getRange(rowNumber, 4).setValue('Disponible');
      sheet.getRange(rowNumber, 5, 1, 6).clearContent();
      return { status: 'success', message: 'Turno cancelado con éxito.' };
    }
  }
  return { status: 'error', message: 'No se encontró el turno.' };
}