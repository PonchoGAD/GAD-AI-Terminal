"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const scheduler_1 = require("./scheduler");
dotenv_1.default.config();
(0, scheduler_1.startAutobuyScheduler)().catch((err) => {
    console.error('[autobuy] Fatal error:', err);
    process.exit(1);
});
