import express from "express";
import { protect } from "./middlewares/auth";
import { requireDevice } from "./middlewares/requireDevice";
import { register, login, refresh, logout } from "./controllers/auth";
import type { AuthRequest } from "./types/auth";

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("Hello World!"));

app.post("/register", requireDevice, register);
app.post("/login", requireDevice, login);
app.post("/refresh", requireDevice, protect, refresh);
app.post("/logout", requireDevice, protect, logout);

app.get("/protected", protect, (req: AuthRequest, res) => {
  res.json({ message: "Authorized", userId: req.userId });
});

export default app;
