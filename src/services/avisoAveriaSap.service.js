// services/avisoAveriaSap.service.js
import { getDestination } from "@sap-cloud-sdk/connectivity";
import { executeHttpRequest } from "@sap-cloud-sdk/http-client";
import {
  DEST_NAME,
  SAP_CLIENT,
  SAP_LANG,
} from "../config/env.js";
import {
  fetchCsrfAndCookies,
  forwardWrite,
} from "../sap/csrf.js";

const SRV_META = "ZCS_GET_WORKORDER_SRV";
const SRV_CAT = "ZSD_CATALOGOS_SRV";
const SRV_CREATE = "ZCS_CREATE_NOTIFICATION_SRV";

// --------------------- HELPERS ---------------------

function qp(extra = {}) {
  const p = new URLSearchParams();

  p.set("sap-client", SAP_CLIENT);
  p.set("sap-language", SAP_LANG || "ES");

  Object.entries(extra).forEach(([key, value]) => {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      p.set(key, String(value));
    }
  });

  return p.toString();
}

function sapDateToISO(value) {
  if (!value) {
    return null;
  }

  if (
    typeof value === "string" &&
    value.startsWith("/Date(")
  ) {
    const ms = parseInt(
      value.replace("/Date(", "").replace(")/", ""),
      10,
    );

    if (!Number.isNaN(ms)) {
      return new Date(ms).toISOString();
    }

    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function extractNotifNoFromText(text) {
  if (!text) {
    return null;
  }

  const matches = String(text).match(/\d{6,}/g);

  if (!matches?.length) {
    return null;
  }

  return matches.sort(
    (a, b) => b.length - a.length,
  )[0];
}

function pickFromReturnResults(returnResults = []) {
  if (
    !Array.isArray(returnResults) ||
    !returnResults.length
  ) {
    return {
      notifNo: null,
      sapMessage: null,
    };
  }

  const successResults = returnResults.filter(
    (result) =>
      String(result?.Type || "").toUpperCase() === "S",
  );

  const pool = successResults.length
    ? successResults
    : returnResults;

  const sapMessage =
    pool.find((result) => result?.Message)?.Message ||
    returnResults.find((result) => result?.Message)
      ?.Message ||
    null;

  const joinedMessages = pool
    .map((result) => String(result?.Message || ""))
    .join(" | ");

  return {
    notifNo: extractNotifNoFromText(joinedMessages),
    sapMessage,
  };
}

/**
 * Quita el encabezado data:image/...;base64, y cualquier espacio
 * o salto de línea. SAP recibirá únicamente el Base64 puro.
 */
function limpiarBase64(value) {
  return String(value || "")
    .trim()
    .replace(/^data:[^;]+;base64,/i, "")
    .replace(/\s/g, "");
}

/**
 * Obtiene una extensión compatible con el JSON esperado por SAP.
 */
function obtenerExtensionArchivo(fileName, mimeType) {
  const extensionFromName = String(fileName || "")
    .split(".")
    .pop()
    .toLowerCase()
    .trim();

  const extensionFromMime = String(mimeType || "")
    .toLowerCase()
    .trim()
    .replace(/^image\//, "");

  let extension =
    extensionFromName ||
    extensionFromMime ||
    "jpg";

  if (extension === "jpeg") {
    extension = "jpg";
  }

  return extension;
}

/**
 * Revisa si SAP devolvió mensajes de error dentro de Return.
 */
function validarRespuestaReturn(returnResults = []) {
  if (!Array.isArray(returnResults)) {
    return;
  }

  const errors = returnResults.filter((result) => {
    const type = String(
      result?.Type || "",
    ).toUpperCase();

    return type === "E" || type === "A";
  });

  if (!errors.length) {
    return;
  }

  const message = errors
    .map((result) => result?.Message)
    .filter(Boolean)
    .join(" | ");

  const error = new Error(
    message || "SAP rechazó la creación del aviso",
  );

  error.statusCode = 400;
  error.sapReturn = errors;

  throw error;
}

// --------------------- 1) META ---------------------

export async function obtenerMetaAvisoAveria({
  orderid,
}) {
  const destination = await getDestination({
    destinationName: DEST_NAME,
  });

  if (!destination) {
    const error = new Error(
      `Destination "${DEST_NAME}" no encontrado`,
    );

    error.statusCode = 404;
    throw error;
  }

  const headerUrl =
    `/sap/opu/odata/sap/${SRV_META}` +
    `/WorkOrderHeaderSet('${encodeURIComponent(orderid)}')` +
    `?${qp({ $format: "json" })}`;

  const headerResponse = await executeHttpRequest(
    destination,
    {
      method: "GET",
      url: headerUrl,
      headers: {
        Accept: "application/json",
      },
    },
  );

  const header =
    headerResponse?.data?.d ??
    headerResponse?.data;

  if (!header?.Orderid) {
    const error = new Error(
      "Orden no encontrada en SAP",
    );

    error.statusCode = 404;
    throw error;
  }

  // PersNo es únicamente informativo; no es obligatorio
  // para crear el aviso.
  let reportedByPersNo = null;

  const operationsUrl =
    `/sap/opu/odata/sap/${SRV_META}` +
    `/WorkOrderHeaderSet('${encodeURIComponent(orderid)}')` +
    `/ToOperations?${qp({ $format: "json" })}`;

  try {
    const operationsResponse =
      await executeHttpRequest(destination, {
        method: "GET",
        url: operationsUrl,
        headers: {
          Accept: "application/json",
        },
      });

    const results =
      operationsResponse?.data?.d?.results ??
      operationsResponse?.data?.value ??
      [];

    const operationWithPerson =
      (Array.isArray(results) &&
        results.find((operation) => {
          const persNo = String(
            operation?.PersNo || "",
          ).trim();

          return (
            persNo !== "" &&
            persNo !== "00000000"
          );
        })) ||
      null;

    if (operationWithPerson) {
      reportedByPersNo = String(
        operationWithPerson.PersNo || "",
      ).replace(/^0+/, "");
    } else {
      const firstOperation =
        Array.isArray(results) && results.length
          ? results[0]
          : null;

      reportedByPersNo = firstOperation?.PersNo
        ? String(firstOperation.PersNo).replace(
            /^0+/,
            "",
          )
        : null;
    }
  } catch (error) {
    console.warn(
      "[AVISO-META] No fue posible obtener PersNo:",
      error?.message,
    );
  }

  /*
   * DocNumber e ItmNumber se mantienen en la respuesta de meta
   * por si el frontend los utiliza en otra parte.
   *
   * Ya no se validan ni se mandan al JSON de creación del aviso.
   */
  return {
    Orderid: header.Orderid,
    Equipment: header.Equipment,
    DocNumber: header.SalesOrd,
    ItmNumber: header.SOrdItem,
    ShortTextDefault:
      header.ShortText ||
      header.SalesOrd ||
      "",
    StartDateISO: sapDateToISO(header.StartDate),
    ReportedByPersNo: reportedByPersNo,
  };
}

// --------------------- 2) CATÁLOGO ---------------------

export async function listarCircunstanciaPorCatalogo({
  catalogo,
}) {
  const destination = await getDestination({
    destinationName: DEST_NAME,
  });

  if (!destination) {
    const error = new Error(
      `Destination "${DEST_NAME}" no encontrado`,
    );

    error.statusCode = 404;
    throw error;
  }

  const url =
    `/sap/opu/odata/sap/${SRV_CAT}/CircunstanciaSet?` +
    qp({
      $filter: `Catalogo eq '${catalogo}'`,
      $format: "json",
    });

  const response = await executeHttpRequest(
    destination,
    {
      method: "GET",
      url,
      headers: {
        Accept: "application/json",
      },
    },
  );

  const results =
    response?.data?.d?.results ??
    response?.data?.value ??
    [];

  return results.map((item) => ({
    Catalogo: item.Catalogo,
    GrupoCodigo: item.GrupoCodigo,
    Codigo: item.Codigo,
    Descripcion: item.Descripcion,
  }));
}

// --------------------- 3) CREAR AVISO ---------------------

export async function crearAvisoAveriaSap(
  payloadIn,
) {
  const destination = await getDestination({
    destinationName: DEST_NAME,
  });

  if (!destination) {
    const error = new Error(
      `Destination "${DEST_NAME}" no encontrado`,
    );

    error.statusCode = 404;
    throw error;
  }

  const {
    equipment,
    shortText,
    itemDescript,
    causaText,
    piezaDescripcion,
    piezaCircList,
    lugarCirc,
    causasCirc,
    email,
    Attachments,
  } = payloadIn || {};

  // ---------------- VALIDACIONES ----------------

  if (!String(equipment || "").trim()) {
    const error = new Error(
      "Equipment es obligatorio",
    );

    error.statusCode = 400;
    throw error;
  }

  if (!String(shortText || "").trim()) {
    const error = new Error(
      "ShortText es obligatorio",
    );

    error.statusCode = 400;
    throw error;
  }

  if (!String(itemDescript || "").trim()) {
    const error = new Error(
      "itemDescript (Descript) es obligatorio",
    );

    error.statusCode = 400;
    throw error;
  }

  if (!String(causaText || "").trim()) {
    const error = new Error(
      "causaText (Causetext) es obligatorio",
    );

    error.statusCode = 400;
    throw error;
  }

  if (!String(piezaDescripcion || "").trim()) {
    const error = new Error(
      "piezaDescripcion es obligatoria " +
        "(NotificationTextSet.TextLine)",
    );

    error.statusCode = 400;
    throw error;
  }

  if (
    !Array.isArray(piezaCircList) ||
    !piezaCircList.length
  ) {
    const error = new Error(
      "Selecciona al menos 1 daño (R)",
    );

    error.statusCode = 400;
    throw error;
  }

  if (!lugarCirc?.Codigo) {
    const error = new Error(
      "Selecciona 1 localización (S)",
    );

    error.statusCode = 400;
    throw error;
  }

  if (
    !Array.isArray(causasCirc) ||
    !causasCirc.length
  ) {
    const error = new Error(
      "Selecciona al menos 1 causa (T)",
    );

    error.statusCode = 400;
    throw error;
  }

  if (!String(email || "").trim()) {
    const error = new Error(
      "email es obligatorio para Refobjectkey",
    );

    error.statusCode = 400;
    throw error;
  }

  // ---------------- NOTIF HEADER ----------------
  // Se manda exactamente como lo solicita SAP.
  // No se incluyen DocNumber ni ItmNumber.

  const NotifHeader = {
    Equipment: String(equipment).trim(),
    ShortText: String(shortText).trim(),
    Refobjectkey: String(email).trim(),
  };

  const lugarGrupo =
    lugarCirc?.GrupoCodigo || "MANTTO";

  const lugarCodigo =
    lugarCirc?.Codigo || "";

  // ---------------- ITEMS / DAÑOS ----------------

  const NotificationItemsSet = piezaCircList.map(
    (damage, index) => {
      const damageGroup =
        damage?.GrupoCodigo || "MANTTO";

      const damageCode =
        damage?.Codigo || "";

      const itemKey = String(index + 1).padStart(
        4,
        "0",
      );

      return {
        ItemKey: itemKey,
        ItemSortNo: itemKey,
        Descript: String(itemDescript).trim(),
        DCodegrp: String(damageGroup),
        DCode: String(damageCode),
        DlCodegrp: String(lugarGrupo),
        DlCode: String(lugarCodigo),
      };
    },
  );

  // ---------------- CAUSAS ----------------

  const NotificationCausesSet = causasCirc.map(
    (cause, index) => {
      const causeGroup =
        cause?.GrupoCodigo || "MANTTO";

      const causeCode =
        cause?.Codigo || "";

      const causeKey = String(index + 1).padStart(
        4,
        "0",
      );

      return {
        ItemKey: "0001",
        ItemSortNo: "0001",
        CauseKey: causeKey,
        CauseSortNo: causeKey,
        CauseCodegrp: String(causeGroup),
        CauseCode: String(causeCode),
        Causetext: String(causaText).trim(),
      };
    },
  );

  // ---------------- TEXTO ----------------

  const NotificationTextSet = [
    {
      Objtype: "QMEL",
      FormatCol: ">X",
      TextLine: String(piezaDescripcion).trim(),
    },
  ];

  // ---------------- ADJUNTOS ----------------

  let AttachmentsOut = [];

  if (
    Array.isArray(Attachments) &&
    Attachments.length
  ) {
    AttachmentsOut = Attachments
      .filter((attachment) => {
        return (
          attachment &&
          limpiarBase64(attachment.Base64)
        );
      })
      .map((attachment) => {
        const fileName = String(
          attachment.FileName || "imagen.jpg",
        ).trim();

        const extension =
          obtenerExtensionArchivo(
            fileName,
            attachment.MimeType,
          );

        return {
          // SAP solicita un espacio en DocId
          DocId: " ",
          FileName: fileName,
          MimeType: extension,
          Base64: limpiarBase64(
            attachment.Base64,
          ),
        };
      });
  }

  console.log("[AVISO-CREATE] Datos preparados:", {
    equipment: NotifHeader.Equipment,
    shortText: NotifHeader.ShortText,
    email: NotifHeader.Refobjectkey,
    items: NotificationItemsSet.length,
    causes: NotificationCausesSet.length,
    texts: NotificationTextSet.length,
    attachmentsIn: Array.isArray(Attachments)
      ? Attachments.length
      : 0,
    attachmentsOut: AttachmentsOut.length,
    firstAttachment:
      AttachmentsOut.length > 0
        ? {
            DocId: AttachmentsOut[0].DocId,
            FileName:
              AttachmentsOut[0].FileName,
            MimeType:
              AttachmentsOut[0].MimeType,
            base64Length:
              AttachmentsOut[0].Base64.length,
          }
        : null,
  });

  // ---------------- JSON FINAL PARA SAP ----------------

  const body = {
    NotifType: "S1",
    NotifHeader,
    NotificationItemsSet,
    NotificationCausesSet,
    NotificationTextSet,
    Attachments: AttachmentsOut,
    Return: [],
  };

  // No se imprime el JSON completo para evitar mostrar
  // todo el Base64 en los logs.
  console.log("[AVISO-CREATE] Enviando aviso a SAP");

  const {
    csrfToken,
    cookies,
  } = await fetchCsrfAndCookies(
    destination,
    SRV_CREATE,
  );

  const postPath =
    `/sap/opu/odata/sap/${SRV_CREATE}` +
    `/NotificationHeaderSet?${qp()}`;

  const response = await forwardWrite({
    destination,
    method: "POST",
    path: postPath,
    body,
    csrfToken,
    cookies,
    contentType: "application/json",
  });

  const responseData =
    response?.data?.d ??
    response?.data;

  const returnResults =
    responseData?.Return?.results ||
    responseData?.Return?.Results ||
    responseData?.Return ||
    [];

  // Si SAP contestó HTTP 200, pero agregó errores
  // dentro de Return, no se reportará como éxito.
  validarRespuestaReturn(returnResults);

  const {
    notifNo,
    sapMessage,
  } = pickFromReturnResults(returnResults);

  return {
    ok: true,
    notifNo,
    sapMessage:
      sapMessage ||
      (notifNo
        ? `Notificación creada: ${notifNo}`
        : "Aviso creado (sin número en respuesta)"),
    raw: responseData,
  };
}