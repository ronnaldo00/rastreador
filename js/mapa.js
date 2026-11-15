// La página que muestra dónde están mis celulares.
// Novedad: maneja VARIOS celulares. Cada uno tiene un nombre y su propia clave.
// Arriba hay un menú para elegir cuál ver.
//
// Cómo funciona, en resumen:
//   1. Guarda una lista de celulares (nombre + clave) y una sola URL de Firebase.
//   2. Cada 15 segundos LEE la última ubicación del celular elegido (un GET).
//   3. Mueve el punto en el mapa y actualiza los datos (hace cuánto, batería…).
//
// La página NUNCA habla con el celular directamente: las dos hablan con Firebase.

// ---------- 1. Configuración (URL + lista de celulares) ----------
// Formato guardado:
//   { urlBase: "...", seleccionado: 0, celulares: [ {nombre, clave}, ... ] }
function leerConfig() {
  let g = {};
  try { g = JSON.parse(localStorage.getItem("rastreador") || "{}"); } catch (e) {}

  // Compatibilidad: si venías de la versión vieja {urlBase, clave}, lo convertimos.
  if (g.clave && !g.celulares) {
    g = { urlBase: g.urlBase, seleccionado: 0, celulares: [{ nombre: "Mi celular", clave: g.clave }] };
  }

  const base = window.CONFIG || {};
  return {
    urlBase: (g.urlBase || base.urlBase || "").replace(/\/+$/, ""),
    celulares: Array.isArray(g.celulares) ? g.celulares : [],
    seleccionado: Number.isInteger(g.seleccionado) ? g.seleccionado : 0
  };
}

function guardarConfig(c) {
  localStorage.setItem("rastreador", JSON.stringify(c));
}

let config = leerConfig();

// ---------- 1b. Enlaces: compartir y pasar la configuración ----------
// localStorage es privado de cada navegador. Para llevar datos de un aparato a
// otro usamos ENLACES que llevan la info metida adentro (codificada). Hay DOS:
//   #ver=…  → ver UN solo celular (para compartir con alguien; NO se guarda).
//   #c=…    → TODA mi configuración (para MI otro aparato; sí se guarda).

// ¿Estamos viendo un enlace COMPARTIDO de un solo celular? (no se guarda nada)
let modoCompartido = false;

// Guarda un objeto como base64 apto para meter en una dirección web, y al revés.
function aBase64(obj) {
  return encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(obj)))));
}
function deBase64(s) {
  return JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(s)))));
}

// Enlace con TODA mi configuración, para pasarla a MI otro aparato (se guarda allá).
function enlaceConfig() {
  return location.origin + location.pathname + "#c=" +
    aBase64({ urlBase: config.urlBase, celulares: config.celulares });
}

// Enlace para COMPARTIR UN SOLO celular con otra persona. Quien lo abra verá
// únicamente ese celular; NO se le guarda ni se mezcla con lo que ya tenga.
function enlaceVer(url, nombre, clave) {
  return location.origin + location.pathname + "#ver=" +
    aBase64({ urlBase: url, nombre: nombre, clave: clave });
}

// Copia un texto al portapapeles (con plan B si el navegador no deja).
async function copiar(texto, mensajeOk) {
  try { await navigator.clipboard.writeText(texto); alert(mensajeOk); }
  catch (e) { prompt("Copia este enlace:", texto); }
}

// Si la página se abrió con un enlace (#ver=… o #c=…), lo aplica.
// Devuelve true si aplicó algo.
function importarDesdeEnlace() {
  const h = location.hash || "";

  // 1) Enlace COMPARTIDO de un solo celular: se VE, pero NO se guarda ni pisa
  //    la lista que tenga quien lo abre.
  let m = h.match(/ver=([^&]+)/);
  if (m) {
    try {
      const d = deBase64(m[1]);
      if (d && d.urlBase && d.clave) {
        config = {
          urlBase: String(d.urlBase).replace(/\/+$/, ""),
          celulares: [{ nombre: d.nombre || "Celular", clave: d.clave }],
          seleccionado: 0
        };
        modoCompartido = true;
        history.replaceState(null, "", location.pathname + location.search);
        return true;
      }
    } catch (e) { console.error("Enlace compartido inválido:", e); }
  }

  // 2) Enlace con TODA mi configuración: se guarda en ESTE navegador.
  m = h.match(/c=([^&]+)/);
  if (m) {
    try {
      const d = deBase64(m[1]);
      if (d && d.urlBase && Array.isArray(d.celulares)) {
        config = {
          urlBase: String(d.urlBase).replace(/\/+$/, ""),
          celulares: d.celulares,
          seleccionado: 0
        };
        guardarConfig(config);
        history.replaceState(null, "", location.pathname + location.search);
        return true;
      }
    } catch (e) { console.error("Enlace de configuración inválido:", e); }
  }
  return false;
}

// En modo compartido ocultamos Ajustes y el menú: quien recibe el enlace solo
// mira ESE celular y no puede ver (ni tocar) los demás.
function aplicarModoCompartido() {
  if (!modoCompartido) return;
  document.getElementById("btn-config").style.display = "none";
  document.getElementById("selector-celular").style.display = "none";
  const cel = celularActual();
  if (cel) document.querySelector("header h1").textContent = "📍 " + cel.nombre;
}

// El celular que estamos viendo ahora (o null si no hay ninguno configurado).
function celularActual() {
  if (!config.celulares.length) return null;
  const i = Math.min(config.seleccionado, config.celulares.length - 1);
  return config.celulares[i];
}

// ---------- 2. El mapa ----------
const mapa = L.map("mapa").setView([5.535, -73.367], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap"
}).addTo(mapa);
L.Icon.Default.prototype.options.imagePath = "vendor/images/";

let marcador = null;      // el "pin" en el mapa
let circulo = null;       // el círculo de precisión alrededor del pin
let recorrido = null;     // la línea del recorrido (historial)
let yaCentre = false;     // para centrar el mapa solo la primera vez
let ultimoDato = null;    // el último reporte recibido

// ---------- 3. Leer el buzón ----------
// urlBase + "/celulares/" + clave + "/" + sufijo + ".json"
function direccion(sufijo) {
  const cel = celularActual();
  return `${config.urlBase}/celulares/${encodeURIComponent(cel.clave)}/${sufijo}.json`;
}

async function pedirUbicacion() {
  const cel = celularActual();
  // Sin configuración no hay nada que pedir: mostramos los ajustes.
  if (!config.urlBase || !cel || cel.clave.length < 20) {
    ponerEstado("gris", "Falta configurar (toca ⚙️)");
    // OJO: solo abrimos Ajustes si NO están ya abiertos. Si no, este temporizador
    // (que corre cada 15 s) volvería a redibujar la ventana y te BORRARÍA lo que
    // estás escribiendo. Ese era el bug de "pongo los datos y se borra todo".
    if (!caja.classList.contains("visible")) abrirConfig();
    return;
  }
  try {
    const resp = await fetch(direccion("ultima"), { cache: "no-store" });
    if (!resp.ok) throw new Error("respuesta " + resp.status);
    const dato = await resp.json();
    if (!dato || typeof dato.lat !== "number") {
      ponerEstado("gris", "Aún no hay reportes de «" + cel.nombre + "»");
      return;
    }
    ultimoDato = dato;
    pintar(dato);
    pintarRecorrido();
  } catch (e) {
    ponerEstado("viejo", "Sin conexión con Firebase");
    console.error(e);
  }
}

// Distancia en METROS entre dos puntos {lat,lng} (fórmula de Haversine).
function metrosEntre(a, b) {
  const R = 6371000;                 // radio de la Tierra en metros
  const rad = (x) => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Limpia el recorrido para que NO dibuje movimientos falsos:
//   - descarta lecturas muy imprecisas (la ubicación por RED da el centro de la
//     ciudad, con cientos de metros de error);
//   - descarta "saltos" imposibles (más de ~180 km/h = teletransporte);
//   - cuando el celular está quieto, no amontona puntos (ruido del GPS parado).
// Devuelve una lista de [lat, lng] lista para la línea.
function filtrarRecorrido(lista) {
  const buenos = [];
  for (const d of lista) {
    if (typeof d.precision === "number" && d.precision > 120) continue; // muy impreciso
    const ult = buenos[buenos.length - 1];
    if (ult) {
      const metros = metrosEntre(ult, d);
      const seg = Math.max(1, (d.hora - ult.hora) / 1000);
      const velocidad = metros / seg;            // m/s
      if (velocidad > 50 && metros > 150) continue; // salto imposible → basura
      if (metros < 8) continue;                     // casi no se movió → no repetir
    }
    buenos.push(d);
  }
  return buenos.map((d) => [d.lat, d.lng]);
}

// Lee el historial y dibuja la línea del recorrido (los últimos 50 puntos).
async function pintarRecorrido() {
  try {
    const resp = await fetch(direccion("historial") + '?orderBy="$key"&limitToLast=50', { cache: "no-store" });
    if (!resp.ok) return;
    const hist = await resp.json();
    if (!hist) { if (recorrido) { recorrido.remove(); recorrido = null; } return; }
    // Ordenamos por hora y limpiamos la basura (ver filtrarRecorrido) para que
    // la línea NO muestre movimientos que no se hicieron.
    const crudos = Object.keys(hist).sort()
      .map((k) => hist[k])
      .filter((d) => d && typeof d.lat === "number" && typeof d.lng === "number");
    const puntos = filtrarRecorrido(crudos);
    if (puntos.length < 2) { if (recorrido) { recorrido.remove(); recorrido = null; } return; }
    if (!recorrido) {
      recorrido = L.polyline(puntos, { color: "#4f7cff", weight: 4, opacity: .6 }).addTo(mapa);
    } else {
      recorrido.setLatLngs(puntos);
    }
  } catch (e) { /* si falla el historial, no pasa nada: el pin sigue */ }
}

// ---------- 4. Pintar en pantalla ----------
function pintar(dato) {
  const punto = [dato.lat, dato.lng];
  if (!marcador) marcador = L.marker(punto).addTo(mapa);
  else marcador.setLatLng(punto);

  if (dato.precision) {
    if (!circulo) {
      circulo = L.circle(punto, { radius: dato.precision, color: "#4f7cff", opacity: .4, fillOpacity: .1 }).addTo(mapa);
    } else {
      circulo.setLatLng(punto).setRadius(dato.precision);
    }
  }

  if (!yaCentre) { mapa.setView(punto, 16); yaCentre = true; }

  marcador.bindPopup(`Visto ${haceCuanto(dato.hora)}<br>${new Date(dato.hora).toLocaleString()}`);
  actualizarDatos(dato);
}

function actualizarDatos(dato) {
  document.getElementById("d-hace").textContent = haceCuanto(dato.hora);
  document.getElementById("d-bateria").textContent =
    (dato.bateria != null ? dato.bateria + " %" : "—") + (dato.cargando ? " ⚡" : "");
  document.getElementById("d-precision").textContent =
    dato.precision != null ? Math.round(dato.precision) + " m" : "—";
  document.getElementById("d-velocidad").textContent =
    dato.velocidad != null ? Math.round(dato.velocidad * 3.6) + " km/h" : "—";

  const minutos = (Date.now() - dato.hora) / 60000;
  if (minutos < 5) ponerEstado("vivo", "En línea · " + haceCuanto(dato.hora));
  else ponerEstado("viejo", "Última vez " + haceCuanto(dato.hora));
}

// ---------- 5. Ayudantes ----------
function haceCuanto(hora) {
  const seg = Math.max(0, Math.floor((Date.now() - hora) / 1000));
  if (seg < 60) return "hace " + seg + " s";
  const min = Math.floor(seg / 60);
  if (min < 60) return "hace " + min + " min";
  const h = Math.floor(min / 60);
  if (h < 24) return "hace " + h + " h";
  return "hace " + Math.floor(h / 24) + " días";
}

function ponerEstado(clase, texto) {
  const punto = document.getElementById("punto-estado");
  punto.className = "";
  if (clase === "vivo") punto.classList.add("vivo");
  if (clase === "viejo") punto.classList.add("viejo");
  document.getElementById("estado-texto").textContent = texto;
}

// Genera una clave secreta nueva al azar (24 letras y números).
function generarClave() {
  const letras = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 24; i++) s += letras[Math.floor(Math.random() * letras.length)];
  return s;
}

// ---------- 6. El menú de celulares (arriba) ----------
function pintarSelector() {
  const sel = document.getElementById("selector-celular");
  sel.innerHTML = "";
  if (!config.celulares.length) {
    const op = document.createElement("option");
    op.textContent = "(sin celulares)";
    sel.appendChild(op);
    sel.style.display = "none";
    return;
  }
  sel.style.display = "";
  config.celulares.forEach((c, i) => {
    const op = document.createElement("option");
    op.value = i;
    op.textContent = c.nombre || ("Celular " + (i + 1));
    if (i === config.seleccionado) op.selected = true;
    sel.appendChild(op);
  });
}

// Al cambiar de celular en el menú: reiniciamos el mapa y pedimos su ubicación.
document.getElementById("selector-celular").onchange = (e) => {
  config.seleccionado = Number(e.target.value);
  guardarConfig(config);
  reiniciarMapa();
  pedirUbicacion();
};

// Borra el pin, el círculo y el recorrido (para empezar limpio con otro celular).
function reiniciarMapa() {
  if (marcador) { marcador.remove(); marcador = null; }
  if (circulo) { circulo.remove(); circulo = null; }
  if (recorrido) { recorrido.remove(); recorrido = null; }
  ultimoDato = null;
  yaCentre = false;
}

// ---------- 7. Ventana de Ajustes ----------
const caja = document.getElementById("config-caja");

function abrirConfig() {
  document.getElementById("in-url").value = config.urlBase;
  pintarListaConfig(config.celulares.length ? config.celulares : [{ nombre: "", clave: "" }]);
  caja.classList.add("visible");
}
function cerrarConfig() { caja.classList.remove("visible"); }

// Dibuja la lista editable de celulares dentro de Ajustes.
function pintarListaConfig(celulares) {
  const cont = document.getElementById("lista-celulares");
  cont.innerHTML = "";
  celulares.forEach((c) => cont.appendChild(filaCelular(c.nombre, c.clave)));
}

// Crea una fila (nombre + clave + botones) para un celular.
function filaCelular(nombre, clave) {
  const item = document.createElement("div");
  item.className = "cel-item";

  const cab = document.createElement("div");
  cab.className = "cabecera";
  const inNombre = document.createElement("input");
  inNombre.className = "cel-nombre";
  inNombre.placeholder = "Nombre (ej. Moto, Cel de mamá)";
  inNombre.value = nombre || "";
  const btnQuitar = document.createElement("button");
  btnQuitar.className = "quitar";
  btnQuitar.textContent = "🗑";
  btnQuitar.title = "Quitar este celular";
  btnQuitar.onclick = () => item.remove();
  cab.appendChild(inNombre);
  cab.appendChild(btnQuitar);

  const filaClave = document.createElement("div");
  filaClave.className = "cel-clave-fila";
  const inClave = document.createElement("input");
  inClave.className = "cel-clave";
  inClave.placeholder = "Clave (20 letras o más)";
  inClave.value = clave || "";
  const btnGen = document.createElement("button");
  btnGen.className = "gris chico";
  btnGen.textContent = "Generar";
  btnGen.title = "Crear una clave nueva al azar";
  btnGen.onclick = () => { inClave.value = generarClave(); };
  filaClave.appendChild(inClave);
  filaClave.appendChild(btnGen);

  // Botón "Compartir SOLO este celular": crea un enlace de solo-ver ese celular.
  const btnCompartir = document.createElement("button");
  btnCompartir.className = "gris chico";
  btnCompartir.textContent = "🔗 Compartir solo este";
  btnCompartir.style.marginTop = "8px";
  btnCompartir.title = "Enlace para que alguien vea SOLO este celular";
  btnCompartir.onclick = () => {
    const url = document.getElementById("in-url").value.trim().replace(/\/+$/, "");
    const clv = inClave.value.trim();
    const nom = inNombre.value.trim() || "Celular";
    if (!url) { alert("Primero escribe la dirección de Firebase arriba."); return; }
    if (clv.length < 20) { alert("Este celular necesita una clave de 20 letras o más."); return; }
    copiar(enlaceVer(url, nom, clv),
      "¡Enlace de «" + nom + "» copiado!\n\nQuien lo abra verá SOLO este celular, " +
      "no los demás. Puedes mandárselo por WhatsApp.");
  };

  item.appendChild(cab);
  item.appendChild(filaClave);
  item.appendChild(btnCompartir);
  return item;
}

document.getElementById("btn-config").onclick = abrirConfig;
document.getElementById("btn-cancelar").onclick = cerrarConfig;

// Botón "Copiar TODA mi configuración": enlace con TODOS mis celulares, para MI
// otro aparato. OJO: lleva TODAS las claves; no es para compartir con otros.
document.getElementById("btn-enlace").onclick = () => {
  if (!config.urlBase || !config.celulares.length) {
    alert("Primero guarda tu Firebase y al menos un celular.");
    return;
  }
  copiar(enlaceConfig(),
    "¡Enlace copiado! Es para TU otro aparato: mándatelo por WhatsApp a ti mismo " +
    "y ábrelo ahí; se cargarán TODOS tus celulares.\n\n⚠️ No se lo mandes a otras " +
    "personas: lleva todas tus claves. Para compartir uno solo, usa el botón " +
    "«🔗 Compartir solo este» de cada celular.");
};
document.getElementById("btn-agregar").onclick = () => {
  document.getElementById("lista-celulares").appendChild(filaCelular("", ""));
};

document.getElementById("btn-guardar").onclick = () => {
  const url = document.getElementById("in-url").value.trim().replace(/\/+$/, "");
  // Recoger todos los celulares de la lista.
  const items = document.querySelectorAll("#lista-celulares .cel-item");
  const celulares = [];
  for (const it of items) {
    const nombre = it.querySelector(".cel-nombre").value.trim();
    const clave = it.querySelector(".cel-clave").value.trim();
    if (!clave && !nombre) continue;        // fila vacía: la ignoramos
    if (clave.length < 20) {
      alert("La clave de «" + (nombre || "un celular") + "» debe tener 20 letras o más.");
      return;
    }
    celulares.push({ nombre: nombre || ("Celular " + (celulares.length + 1)), clave });
  }
  if (!url) { alert("Escribe la dirección de Firebase."); return; }
  if (!celulares.length) { alert("Agrega al menos un celular con su clave."); return; }

  config = {
    urlBase: url,
    celulares,
    seleccionado: Math.min(config.seleccionado, celulares.length - 1)
  };
  guardarConfig(config);
  pintarSelector();
  reiniciarMapa();
  cerrarConfig();
  pedirUbicacion();
};

// ---------- 8. Arranque ----------
// Si abriste la página con un enlace (compartido o de configuración), aplícalo.
importarDesdeEnlace();
pintarSelector();
aplicarModoCompartido();   // si es un enlace compartido, oculta ajustes y menú
pedirUbicacion();
setInterval(pedirUbicacion, 15000);
setInterval(() => { if (ultimoDato) actualizarDatos(ultimoDato); }, 1000);
