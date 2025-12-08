import { createServer } from "node:http";
import { fileURLToPath } from "url";
import { hostname } from "node:os";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import crypto from "node:crypto";

import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import fs from 'node:fs';

// Check for required static directories
const requiredDirs = [
    { path: scramjetPath, name: 'Scramjet' },
    { path: epoxyPath, name: 'Epoxy' },
    { path: baremuxPath, name: 'BareMux' }
];

requiredDirs.forEach(({ path, name }) => {
    if (!fs.existsSync(path)) {
        console.warn(`[Warning] Required static directory for ${name} not found at: ${path}`);
    } else {
        console.log(`[Info] Found ${name} static directory at: ${path}`);
    }
});

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));

// Detect Dev Environment (Codespaces or Local Development)
const IS_DEV = process.env.CODESPACES === 'false' || process.env.NODE_ENV === 'production';

const TURNSTILE_SECRET = "0x4AAAAAACFRVeaaQ0ZyNngoBHHl6-Cvjok";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

logging.set_level(logging.INFO);
Object.assign(wisp.options, {
	allow_udp_streams: false,
	hostname_blacklist: [/example\.com/],
	dns_servers: ["1.1.1.1", "8.8.8.8"]
});

class TurnstileValidator {
	constructor(secretKey, timeout = 10000) {
		this.secretKey = secretKey;
		this.timeout = timeout;
		this.validatedTokens = new Map();
		this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
	}

	cleanup() {
		const now = Date.now();
		for (const [token, timestamp] of this.validatedTokens.entries()) {
			if (now - timestamp > 300000) {
				this.validatedTokens.delete(token);
			}
		}
	}

	async validate(token, remoteip, options = {}) {
		if (!token || typeof token !== "string") {
			return { success: false, error: "Invalid token format", "error-codes": ["invalid-input-response"] };
		}

		if (token.length > 2048) {
			return { success: false, error: "Token too long", "error-codes": ["invalid-input-response"] };
		}

		if (this.validatedTokens.has(token)) {
			return { success: false, error: "Token already used", "error-codes": ["timeout-or-duplicate"] };
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const formData = new URLSearchParams();
			formData.append("secret", this.secretKey);
			formData.append("response", token);
			
			if (remoteip) {
				formData.append("remoteip", remoteip);
			}

			if (options.idempotencyKey) {
				formData.append("idempotency_key", options.idempotencyKey);
			}

			const response = await fetch(TURNSTILE_VERIFY_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: formData.toString(),
				signal: controller.signal,
			});

			if (!response.ok) {
				return { 
					success: false, 
					error: "Verification request failed", 
					"error-codes": ["bad-request"] 
				};
			}

			const result = await response.json();

			if (result.success) {
				if (options.expectedAction && result.action !== options.expectedAction) {
					return {
						success: false,
						error: "Action mismatch",
						expected: options.expectedAction,
						received: result.action,
						"error-codes": ["invalid-input-response"]
					};
				}

				if (options.expectedHostname && result.hostname !== options.expectedHostname) {
					return {
						success: false,
						error: "Hostname mismatch",
						expected: options.expectedHostname,
						received: result.hostname,
						"error-codes": ["invalid-input-response"]
					};
				}

				const challengeTime = new Date(result.challenge_ts);
				const now = new Date();
				const ageMinutes = (now - challengeTime) / (1000 * 60);

				if (ageMinutes > 5) {
					return {
						success: false,
						error: "Token expired",
						"error-codes": ["timeout-or-duplicate"]
					};
				}

				this.validatedTokens.set(token, Date.now());
			}

			return result;
		} catch (error) {
			if (error.name === "AbortError") {
				return { success: false, error: "Validation timeout", "error-codes": ["internal-error"] };
			}

			console.error("[Turnstile] Validation error:", error);
			return { success: false, error: "Internal error", "error-codes": ["internal-error"] };
		} finally {
			clearTimeout(timeoutId);
		}
	}

	async validateWithRetry(token, remoteip, maxRetries = 3) {
		const idempotencyKey = crypto.randomUUID();

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				const result = await this.validate(token, remoteip, { idempotencyKey });

				if (result.success || attempt === maxRetries) {
					return result;
				}

				if (result["error-codes"] && !result["error-codes"].includes("internal-error")) {
					return result;
				}

				await new Promise((resolve) =>
					setTimeout(resolve, Math.pow(2, attempt) * 1000)
				);
			} catch (error) {
				if (attempt === maxRetries) {
					return { success: false, "error-codes": ["internal-error"] };
				}
			}
		}
	}

	destroy() {
		clearInterval(this.cleanupInterval);
		this.validatedTokens.clear();
	}
}

const validator = new TurnstileValidator(TURNSTILE_SECRET);

const fastify = Fastify({
	serverFactory: (handler) => {
		return createServer()
			.on("request", (req, res) => {
				// Security Headers
				res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
				res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
				res.setHeader("X-Content-Type-Options", "nosniff");
				res.setHeader("X-Frame-Options", "SAMEORIGIN");
				res.setHeader("X-XSS-Protection", "1; mode=block");
				res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
				res.setHeader("Referrer-Policy", "no-referrer");
				
				handler(req, res);
			})
			.on("upgrade", (req, socket, head) => {
				if (req.url.endsWith("/wisp/") || req.url.endsWith("/wisp")) {
					wisp.routeRequest(req, socket, head);
				} else {
					socket.end();
				}
			});
	},
});

fastify.register(fastifyStatic, {
	root: publicPath,
	decorateReply: true,
});

fastify.register(fastifyStatic, {
	root: scramjetPath,
	prefix: "/scram/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: epoxyPath,
	prefix: "/epoxy/",
	decorateReply: false,
});

fastify.register(fastifyStatic, {
	root: baremuxPath,
	prefix: "/baremux/",
	decorateReply: false,
});

// Status endpoint for client to check dev mode
fastify.get("/api/status", async (req, reply) => {
    return { 
        status: "online", 
        devMode: IS_DEV,
        turnstileEnabled: !IS_DEV 
    };
});

fastify.post("/api/verify-turnstile", async (req, reply) => {
    // Bypass for Dev Mode
    if (IS_DEV) {
        console.log(`[Turnstile] ⚠️ Dev Mode: Bypassing verification for IP: ${req.ip}`);
        return reply.send({ 
            success: true, 
            message: "Dev Mode Bypass",
            challenge_ts: new Date().toISOString(),
            hostname: "localhost"
        });
    }

	const { token } = req.body || {};
	
	if (!token) {
		return reply.code(400).send({ 
			success: false, 
			error: "No token provided",
			"error-codes": ["missing-input-response"]
		});
	}

	const remoteip = req.headers["cf-connecting-ip"] || 
	                 req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
	                 req.headers["x-real-ip"] ||
	                 req.socket.remoteAddress;

	try {
		const result = await validator.validateWithRetry(token, remoteip);
		
		if (result.success) {
			console.log(`[Turnstile] ✅ Verification successful for IP: ${remoteip}`);
			console.log(`[Turnstile] Challenge timestamp: ${result.challenge_ts}`);
			console.log(`[Turnstile] Hostname: ${result.hostname}`);
			
			return reply.send({ 
				success: true, 
				message: "Verification successful",
				challenge_ts: result.challenge_ts,
				hostname: result.hostname
			});
		} else {
			console.warn(`[Turnstile] ❌ Verification failed for IP: ${remoteip}`);
			console.warn(`[Turnstile] Error codes:`, result["error-codes"]);
			
			return reply.code(403).send({ 
				success: false, 
				error: "Verification failed",
				errorCodes: result["error-codes"]
			});
		}
	} catch (error) {
		console.error("[Turnstile] ⚠️ Verification error:", error);
		return reply.code(500).send({ 
			success: false, 
			error: "Server error during verification",
			"error-codes": ["internal-error"]
		});
	}
});

fastify.post("/api/restart", async (req, reply) => {
	const { pin } = req.body || {};
	
	if (pin === "2520") {
		reply.send("Restarting server...");
		setTimeout(() => {
			process.exit(0);
		}, 1000);
	} else {
		reply.code(403).send("Invalid PIN");
	}
});

fastify.setNotFoundHandler((req, reply) => {
	return reply.code(404).type("text/html").sendFile("404.html");
});

fastify.server.on("listening", () => {
	const address = fastify.server.address();

	console.log("╔════════════════════════════════════════╗");
	console.log("║     🌌 Aurora Browser Server         ║");
	console.log("╠════════════════════════════════════════╣");
	console.log("║  🛡️  Turnstile Protection: ENABLED    ║");
	console.log("║  ⚡ Bot Evasion: ACTIVE               ║");
	console.log("╠════════════════════════════════════════╣");
	console.log("║  Listening on:                        ║");
	console.log(`║    http://localhost:${address.port}               ║`);
	console.log(`║    http://${hostname()}:${address.port}      ║`);
	console.log(`║    http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}  ║`);
	console.log("╚════════════════════════════════════════╝");
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
	console.log("\n[Server] SIGTERM signal received: closing HTTP server");
	validator.destroy();
	fastify.close();
	process.exit(0);
}

let port = parseInt(process.env.PORT || "");

if (isNaN(port)) port = 8080;

fastify.listen({
	port: port,
	host: "0.0.0.0",
});

