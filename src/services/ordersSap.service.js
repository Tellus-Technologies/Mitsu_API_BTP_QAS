// src/services/ordersSap.service.js
import { getDestination } from "@sap-cloud-sdk/connectivity";
import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import { DEST_NAME, SAP_CLIENT, SAP_LANG, log } from "../config/env.js";
import { fetchStatusCatalog, mapUserstatusToUi } from "./statusCatalog.js";
import { fetchCsrfAndCookies, forwardWrite } from "../sap/csrf.js";

/* ====================== Helpers ====================== */
function safeYmd(ymd) {
  const s = String(ymd || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;

  return s;
}

function sapV2DateToISO(val) {
  if (!val) return null;

  if (typeof val === "string" && val.startsWith("/Date(")) {
    const ms = parseInt(val.replace("/Date(", "").replace(")/", ""), 10);

    if (!Number.isNaN(ms)) return new Date(ms).toISOString();

    return null;
  }

  const d = new Date(val);

  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function getShortTextFromSap(wo = {}) {
  return String(
    wo?.ShortText ||
      wo?.Shorttext ||
      wo?.shortText ||
      wo?.short_text ||
      wo?.Description ||
      wo?.description ||
      ""
  ).trim();
}

/** ===================== LISTA ÓRDENES ===================== */
export async function listOrdenesSap({ start, end, user, mode = "range" }) {
  const s = safeYmd(start);
  const e = safeYmd(end);
  const u = String(user || "").trim();

  if (!s || !e || !u) {
    const err = new Error("Faltan parámetros start/end/user (YYYY-MM-DD)");
    err.statusCode = 400;
    throw err;
  }

  const d = await getDestination({ destinationName: DEST_NAME });

  if (!d) {
    const err = new Error(`Destination "${DEST_NAME}" no encontrado`);
    err.statusCode = 404;
    throw err;
  }

  const statusMap = await fetchStatusCatalog(d);

  // eq = un solo día, range = rango completo
  const startDT = `${s}T00:00:00`;
  const endDT = mode === "eq" ? `${s}T23:59:59` : `${e}T23:59:59`;

  const filter =
    `StartDate ge datetime'${startDT}' ` +
    `and FinishDate le datetime'${endDT}' ` +
    `and Userstatus eq '${u}'`;

  const qp = new URLSearchParams();
  qp.set("$filter", filter);
  qp.set("$format", "json");
  qp.set("sap-client", SAP_CLIENT);
  qp.set("sap-language", SAP_LANG);

  const path = `/sap/opu/odata/sap/ZCS_GET_WORKORDER_SRV/WorkOrderHeaderSet?${qp.toString()}`;

  log("GET", d.url + path);
  console.log("[ORDENES][LIST] user =", u);
  console.log("[ORDENES][LIST] mode =", mode);
  console.log("[ORDENES][LIST] $filter =", filter);

  const r = await executeHttpRequest(d, {
    method: "GET",
    url: path,
    headers: { Accept: "application/json" },
  });

  const results = r?.data?.d?.results || [];

  return results.map((wo) => {
    const us = wo?.Userstatus || "";
    const ui = mapUserstatusToUi(us, statusMap);

    const orderid = wo?.Orderid || wo?.OrderId || wo?.Aufnr || "";

    const startISO = sapV2DateToISO(
      wo?.StartDate || wo?.Startdate || wo?.Start_date
    );

    const endISO = sapV2DateToISO(
      wo?.FinishDate || wo?.Finishdate || wo?.Finish_date
    );

    // ✅ Campo de cobertura que viene de SAP
    const shortText = getShortTextFromSap(wo);

    return {
      Orderid: orderid,
      orderid,

      order_type: wo?.Auart || wo?.OrderType || "",
      nombre_orden: wo?.Auart || wo?.OrderType || "",

      equipment: wo?.Equnr || wo?.Equipment || "",

      start_date: startISO,
      startdate: startISO,
      finish_date: endISO,
      finishdate: endISO,

      partner_name: wo?.PartnerName || wo?.Name1 || "",
      partner_address: wo?.PartnerAddress || wo?.Stras || wo?.Ort01 || "",

      id_mecanico: wo?.IdMecanico || "",
      nombre_mecanico: wo?.NombreMec || "",
      nombre_cliente: wo?.NombreCliente || "",

      // ✅ Cobertura de la orden
      // En SAP viene como ShortText:
      // "COBERTURA BASICA | Plan: 01|07"
      ShortText: shortText,
      shortText,
      short_text: shortText,
      cobertura: shortText,

      userstatus: us,

      // UI mapping:
      // Sin estatus = Sin empezar
      // 0100 = PENDIENTE
      // 0200 = EN PROCESO
      // 0300 = FINALIZADA
      // 0400 = PENDIENTE DE FIRMA
      // 0600 = Carta No Mantto
      ...ui,
    };
  });
}

/** ===================== CHECK-IN ===================== */
export async function checkinOrdenSap({
  orderId,
  base64,
  fileName,
  mimeType,
  docId,
}) {
  if (!orderId) {
    const e = new Error("Falta orderId");
    e.statusCode = 400;
    throw e;
  }

  if (!base64) {
    const e = new Error("Falta base64");
    e.statusCode = 400;
    throw e;
  }

  const safeFileName = String(fileName || "imagen.jpg");
  const safeMimeType = String(mimeType || "image/jpeg");
  const safeDocId = String(docId || "40000118");

  const d = await getDestination({ destinationName: DEST_NAME });

  if (!d) {
    const e = new Error(`Destination "${DEST_NAME}" no encontrado`);
    e.statusCode = 404;
    throw e;
  }

  // ✅ Tu helper fetchCsrfAndCookies regresa csrfToken/cookies
  const { csrfToken, cookies } = await fetchCsrfAndCookies(
    d,
    "ZCS_CHANGE_WORKORDER_SRV"
  );

  const pathWorkOrderSet =
    `/sap/opu/odata/sap/ZCS_CHANGE_WORKORDER_SRV/WorkOrderSet` +
    `?sap-client=${SAP_CLIENT}&sap-language=${SAP_LANG}`;

  // 1) Adjuntar evidencia
  const attachPayload = {
    WorkOrderHeader: {
      Orderid: String(orderId),
    },
    Attachments: [
      {
        DocId: safeDocId,
        FileName: safeFileName,
        MimeType: safeMimeType,
        Base64: String(base64).trim(),
      },
    ],
    Return: [],
  };

  console.log(
    "[CHECKIN] attachPayload =",
    JSON.stringify(
      {
        ...attachPayload,
        Attachments: attachPayload.Attachments.map((a) => ({
          ...a,
          Base64: `<<base64 omitted: ${String(a.Base64 || "").length} chars>>`,
        })),
      },
      null,
      2
    )
  );

  const rAttach = await forwardWrite({
    destination: d,
    method: "POST",
    path: pathWorkOrderSet,
    body: attachPayload,
    csrfToken,
    cookies,
    contentType: "application/json",
  });

  // 2) Cambiar status a 0100 = PENDIENTE
  const statusPayload = {
    OrderId: String(orderId),
    WorkOrderHeader: {
      Orderid: String(orderId),
    },
    WorkOrderUserStatusSet: [
      {
        UserStText: "0100",
        Langu: "ES",
        Inactive: "",
      },
    ],
    Return: [],
  };

  console.log("[CHECKIN] statusPayload =", JSON.stringify(statusPayload, null, 2));

  const rStatus = await forwardWrite({
    destination: d,
    method: "POST",
    path: pathWorkOrderSet,
    body: statusPayload,
    csrfToken,
    cookies,
    contentType: "application/json",
  });

  return {
    ok: true,
    orderId: String(orderId),
    estatus_code: "0100",
    userstatus: "0100",
    estatus_label: "PENDIENTE",
    estatus_tipo: "NORMAL",
    attachment: rAttach?.data || null,
    statusChange: rStatus?.data || null,
  };
}

/** ===================== DETALLE 1 ORDEN ===================== */
export async function getOrdenSapById(orderidRaw) {
  const orderid = String(orderidRaw || "").trim();

  if (!orderid) {
    const e = new Error("Falta orderid");
    e.statusCode = 400;
    throw e;
  }

  const d = await getDestination({ destinationName: DEST_NAME });

  if (!d) {
    const e = new Error(`Destination "${DEST_NAME}" no encontrado`);
    e.statusCode = 404;
    throw e;
  }

  const statusMap = await fetchStatusCatalog(d);

  const qp = new URLSearchParams();
  qp.set("$format", "json");
  qp.set("sap-client", SAP_CLIENT);
  qp.set("sap-language", SAP_LANG);

  const path = `/sap/opu/odata/sap/ZCS_GET_WORKORDER_SRV/WorkOrderHeaderSet('${encodeURIComponent(
    orderid
  )}')?${qp.toString()}`;

  log("GET", d.url + path);

  const r = await executeHttpRequest(d, {
    method: "GET",
    url: path,
    headers: { Accept: "application/json" },
  });

  const wo = r?.data?.d || null;

  if (!wo) {
    const e = new Error(`Orden no encontrada: ${orderid}`);
    e.statusCode = 404;
    throw e;
  }

  const us = wo?.Userstatus || "";
  const ui = mapUserstatusToUi(us, statusMap);

  const startISO = sapV2DateToISO(
    wo?.StartDate || wo?.Startdate || wo?.Start_date
  );

  const endISO = sapV2DateToISO(
    wo?.FinishDate || wo?.Finishdate || wo?.Finish_date
  );

  // ✅ Campo de cobertura que viene de SAP
  const shortText = getShortTextFromSap(wo);

  return {
    Orderid: wo?.Orderid || wo?.OrderId || wo?.Aufnr || orderid,
    orderid: wo?.Orderid || wo?.OrderId || wo?.Aufnr || orderid,

    order_type: wo?.Auart || wo?.OrderType || "",
    nombre_orden: wo?.Auart || wo?.OrderType || "",

    equipment: wo?.Equnr || wo?.Equipment || "",

    start_date: startISO,
    finish_date: endISO,

    partner_name: wo?.PartnerName || wo?.Name1 || "",
    partner_address: wo?.PartnerAddress || wo?.Stras || wo?.Ort01 || "",

    id_mecanico: wo?.IdMecanico || "",
    nombre_mecanico: wo?.NombreMec || "",
    nombre_cliente: wo?.NombreCliente || "",

    // ✅ Cobertura de la orden
    ShortText: shortText,
    shortText,
    short_text: shortText,
    cobertura: shortText,

    userstatus: us,
    ...ui,

    raw: wo,
  };
}

/** ===================== DIRECCIONES DE 1 ORDEN ===================== */
export async function getOrdenAddressesSap(orderidRaw) {
  const orderid = String(orderidRaw || "").trim();

  if (!orderid) {
    const e = new Error("Falta orderid");
    e.statusCode = 400;
    throw e;
  }

  const d = await getDestination({ destinationName: DEST_NAME });

  if (!d) {
    const e = new Error(`Destination "${DEST_NAME}" no encontrado`);
    e.statusCode = 404;
    throw e;
  }

  const qp = new URLSearchParams();
  qp.set("$format", "json");
  qp.set("sap-client", SAP_CLIENT);
  qp.set("sap-language", SAP_LANG);

  const path =
    `/sap/opu/odata/sap/ZCS_GET_WORKORDER_SRV/` +
    `WorkOrderHeaderSet('${encodeURIComponent(orderid)}')/ToAddresses?${qp.toString()}`;

  log("GET", d.url + path);

  const r = await executeHttpRequest(d, {
    method: "GET",
    url: path,
    headers: { Accept: "application/json" },
  });

  const results = r?.data?.d?.results || [];

  return results;
}