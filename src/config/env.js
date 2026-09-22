// src/config/env.js
export const PORT = process.env.PORT || 8080;

export const DEST_NAME = process.env.DEST_NAME || "onPremECC_QAS_APP";
export const SAP_CLIENT = process.env.SAP_CLIENT || "400";
export const SAP_LANG = process.env.SAP_LANGUAGE || "ES";

// Estos DEBEN venir del frontend (los que dices que están bien)
export const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || "";
export const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || "";

// (Opcional) Si quieres exigir scope específico
// Ejemplo típico: access_as_user
export const AZURE_EXPECTED_SCOPE = process.env.AZURE_EXPECTED_SCOPE || "";

// (Opcional) Si usas roles de app y quieres exigir alguno
// export const AZURE_REQUIRED_ROLE = process.env.AZURE_REQUIRED_ROLE || "";

export const READ_ONLY_SERVICES = [
  "ZCS_GET_WORKORDER_SRV",
  "ZCS_GET_NOTIFICATION_SRV",
  "ZCS_GET_BOM_MATERIAL_SRV",
  "ZCS_GET_EQUIPMENT_SRV",
  "ZMM_GET_RESERVATION_SRV",
  "ZSD_CATALOGOS_SRV",
  "ZCS_GEOLOZACION_SRV",
  "ZSD_GET_CONTRACT_CUSTOMER_SRV",

//DASHBOARDS
  "ZPM_BTP_DASHMANTTO_SRV"
];

export const WRITE_SERVICES = [
  "ZCS_CREATE_CONFIRMATION_SRV",
  "ZCS_CREATE_NOTIFICATION_SRV",
  "ZCS_CREATE_WORKORDER_SRV",
  "ZCS_CREATE_WORKORDER_SRV_02",
  "ZCS_CHANGE_AVISO_SRV",
  "ZCS_CHANGE_WORKORDER_SRV",
  "ZCS_RESCHEDULE_WORKORDER_SRV",
  "ZCS_GEOLOZACION_SRV",
  "ZSD_CHANGE_CONTRACT_CUSTOMER_SRV"
];

export const log = (...args) => console.log("[my-node-api]", ...args);
