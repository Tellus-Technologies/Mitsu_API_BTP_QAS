// routes/avisoAveria.routes.js
import express from "express";
import { verifyAzureToken } from "../middlewares/verifyAzureToken.js";
import {
  obtenerMetaAvisoAveria,
  listarCircunstanciaPorCatalogo,
  crearAvisoAveriaSap,
} from "../services/avisoAveriaSap.service.js";

const router = express.Router();

/**
 * Extrae el mensaje más útil posible de un error de SAP,
 * Axios, SAP Cloud SDK o de una validación interna.
 */
function obtenerDetalleError(error) {
  const sapData = error?.response?.data;

  return (
    sapData?.error?.message?.value ||
    sapData?.error?.message ||
    sapData?.message ||
    error?.message ||
    String(error)
  );
}

/**
 * Muestra en consola la respuesta de SAP sin provocar otro error
 * en caso de que el objeto no pueda convertirse a JSON.
 */
function registrarError(contexto, error) {
  const sapData = error?.response?.data;

  console.error(`[${contexto}] Status:`, error?.response?.status);
  console.error(`[${contexto}] Mensaje:`, error?.message);

  if (sapData) {
    try {
      console.error(
        `[${contexto}] Respuesta SAP:`,
        JSON.stringify(sapData, null, 2),
      );
    } catch {
      console.error(`[${contexto}] Respuesta SAP sin formato:`, sapData);
    }
  }
}

// GET /api/aviso-averia/meta/:orderid
router.get("/meta/:orderid", verifyAzureToken, async (req, res) => {
  try {
    const orderid = String(req.params.orderid || "").trim();

    if (!orderid || orderid === "undefined" || orderid === "null") {
      return res.status(400).json({
        ok: false,
        error: "Falta orderid",
      });
    }

    const data = await obtenerMetaAvisoAveria({ orderid });

    return res.json(data);
  } catch (error) {
    registrarError("AVISO-META", error);

    const status =
      error?.statusCode ||
      error?.response?.status ||
      500;

    return res.status(status).json({
      ok: false,
      error: "Error meta aviso",
      detail: obtenerDetalleError(error),
      sapError: error?.response?.data || null,
    });
  }
});

// GET /api/aviso-averia/catalogos/circunstancia?catalogo=R|S|T|P
router.get(
  "/catalogos/circunstancia",
  verifyAzureToken,
  async (req, res) => {
    try {
      const catalogo = String(req.query.catalogo || "")
        .trim()
        .toUpperCase();

      if (!catalogo) {
        return res.status(400).json({
          ok: false,
          error: "Debes enviar ?catalogo=P|R|S|T",
        });
      }

      if (!["P", "R", "S", "T"].includes(catalogo)) {
        return res.status(400).json({
          ok: false,
          error: "El catálogo debe ser P, R, S o T",
        });
      }

      const data = await listarCircunstanciaPorCatalogo({
        catalogo,
      });

      return res.json(data);
    } catch (error) {
      registrarError("AVISO-CATALOGO", error);

      const status =
        error?.statusCode ||
        error?.response?.status ||
        500;

      return res.status(status).json({
        ok: false,
        error: "Error catálogo",
        detail: obtenerDetalleError(error),
        sapError: error?.response?.data || null,
      });
    }
  },
);

// POST /api/aviso-averia/create
router.post("/create", verifyAzureToken, async (req, res) => {
  try {
    const emailFromToken =
      req?.user?.email ||
      req?.user?.correo ||
      req?.user?.preferred_username ||
      req?.user?.upn ||
      null;

    const email =
      String(emailFromToken || req.body?.email || "").trim();

    console.log("[AVISO-CREATE] Solicitud recibida:", {
      equipment: req.body?.equipment,
      shortText: req.body?.shortText,
      email,
      items: Array.isArray(req.body?.piezaCircList)
        ? req.body.piezaCircList.length
        : 0,
      causas: Array.isArray(req.body?.causasCirc)
        ? req.body.causasCirc.length
        : 0,
      attachments: Array.isArray(req.body?.Attachments)
        ? req.body.Attachments.length
        : 0,
    });

    const out = await crearAvisoAveriaSap({
      ...req.body,
      email,
    });

    return res.json(out);
  } catch (error) {
    registrarError("AVISO-CREATE", error);

    const status =
      error?.statusCode ||
      error?.response?.status ||
      500;

    return res.status(status).json({
      ok: false,
      error: "Error crear aviso",
      detail: obtenerDetalleError(error),
      sapError: error?.response?.data || null,
    });
  }
});

export default router;