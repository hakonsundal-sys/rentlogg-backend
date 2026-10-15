import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { safeOriginalName, compressUploadedPhoto, imageFileFilter, removeUploadedFile } from "../utils/uploads.js";
import {
  addPersonalPhoto, getPersonalPhoto, listOwnPersonalPhotos, listCompanyPersonalPhotos, deletePersonalPhoto,
} from "../services/personalPhotos.js";

// "Mine bilder" — see services/personalPhotos.js. Who may do what:
//   cleaner            her own photos: add, list, delete
//   admin / manager    their own too, plus read every photo in the company and remove any of them
//   customer           nothing, ever
// The file itself is served by /uploads under the same rule (routes/uploads.js): the owner, or an
// admin/manager in the same company.
export const personalPhotosRouter = Router();

const STAFF = ["cleaner", "admin", "manager"];
const MAX_NOTE_CHARS = 500;

const upload = multer({
  storage: multer.diskStorage({
    destination: process.env.UPLOADS_DIR || "uploads/",
    filename: (req, file, cb) => cb(null, `${Date.now()}-${safeOriginalName(file.originalname)}`),
  }),
  fileFilter: imageFileFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
});

const managesStaff = (user) => user.role === "admin" || user.role === "manager";

// Her own photos, newest first.
personalPhotosRouter.get("/", requireAuth, requireRole(...STAFF), (req, res) => {
  res.json(listOwnPersonalPhotos(req.user.id));
});

// Everyone's, for the people who answer for them. Optional ?user_id= narrows it to one person.
personalPhotosRouter.get("/all", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  if (req.query.user_id && !Number.isInteger(userId)) return res.status(400).json({ code: "invalid_user", error: "Ugyldig bruker." });
  res.json(listCompanyPersonalPhotos(req.user.company_id, userId));
});

personalPhotosRouter.post("/", requireAuth, requireRole(...STAFF), upload.single("photo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ code: "no_file_uploaded", error: "No file uploaded (field name must be 'photo')" });
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, MAX_NOTE_CHARS) : "";
  const storedName = await compressUploadedPhoto(process.env.UPLOADS_DIR || "uploads", req.file.filename);
  const photo = addPersonalPhoto({
    companyId: req.user.company_id,
    userId: req.user.id,
    filePath: path.join("uploads", storedName),
    note,
  });
  res.status(201).json(photo);
});

// The owner removes her own; an admin/manager can remove anyone's in the company. Another cleaner's id
// answers 404 rather than 403, so the existence of somebody else's photo is not something to probe for.
personalPhotosRouter.delete("/:id", requireAuth, requireRole(...STAFF), (req, res) => {
  const photo = getPersonalPhoto(Number(req.params.id));
  const allowed = photo && photo.company_id === req.user.company_id && (photo.user_id === req.user.id || managesStaff(req.user));
  if (!allowed) return res.status(404).json({ code: "not_found", error: "Not found" });
  deletePersonalPhoto(photo.id);
  removeUploadedFile(path.basename(photo.file_path));
  res.json({ ok: true });
});
