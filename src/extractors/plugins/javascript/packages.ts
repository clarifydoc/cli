import type { KnownPackageRule } from "../../../types/language-plugin.js";

/**
 * npm package recognition (shared by the TypeScript + JavaScript metas).
 * Plugin-owned so the core inventory holds no hardcoded package names. Add a
 * package = add a line here. Frameworks first, then plain categories.
 */
export const npmPackages: readonly KnownPackageRule[] = [
  // ── Frontend frameworks ──
  { names: ["react", "react-dom"], category: "frontend", framework: { id: "react", name: "React" } },
  { names: ["react-router", "react-router-dom"], category: "framework", framework: { id: "react-router", name: "React Router" } },
  { names: ["next"], category: "frontend", framework: { id: "nextjs", name: "Next.js" } },
  { names: ["@remix-run/react", "@remix-run/node", "remix"], category: "frontend", framework: { id: "remix", name: "Remix" } },
  { names: ["gatsby"], category: "frontend", framework: { id: "gatsby", name: "Gatsby" } },
  { names: ["astro"], category: "frontend", framework: { id: "astro", name: "Astro" } },
  { names: ["@builder.io/qwik", "@builder.io/qwik-city"], category: "frontend", framework: { id: "qwik", name: "Qwik" } },
  { names: ["solid-js", "@solidjs/router", "solid-start"], category: "frontend", framework: { id: "solid", name: "SolidJS" } },
  { names: ["preact"], category: "frontend", framework: { id: "preact", name: "Preact" } },
  { names: ["vue"], category: "frontend", framework: { id: "vue", name: "Vue" } },
  { names: ["vue-router"], category: "framework", framework: { id: "vue-router", name: "Vue Router" } },
  { names: ["nuxt", "nuxt3", "nuxt-edge"], category: "frontend", framework: { id: "nuxt", name: "Nuxt" } },
  { names: ["@quasar/app-vite", "@quasar/app-webpack", "quasar"], category: "frontend", framework: { id: "quasar", name: "Quasar" } },
  { names: ["svelte"], category: "frontend", framework: { id: "svelte", name: "Svelte" } },
  { names: ["@sveltejs/kit"], category: "frontend", framework: { id: "sveltekit", name: "SvelteKit" } },
  { names: ["@angular/core"], category: "frontend", framework: { id: "angular", name: "Angular" } },
  { names: ["@ionic/angular", "@ionic/react", "@ionic/vue"], category: "frontend", framework: { id: "ionic", name: "Ionic" } },
  { names: ["ember-source", "ember-cli"], category: "frontend", framework: { id: "ember", name: "Ember.js" } },
  { names: ["alpinejs"], category: "frontend", framework: { id: "alpine", name: "Alpine.js" } },
  { names: ["lit", "lit-element"], category: "frontend", framework: { id: "lit", name: "Lit" } },
  { names: ["@stencil/core"], category: "frontend", framework: { id: "stencil", name: "Stencil" } },
  { names: ["react-native", "expo"], category: "frontend", framework: { id: "react-native", name: "React Native" } },
  // ── Server frameworks ──
  { names: ["express"], category: "framework", framework: { id: "express", name: "Express" } },
  { names: ["koa"], category: "framework", framework: { id: "koa", name: "Koa" } },
  { names: ["@hapi/hapi", "hapi"], category: "framework", framework: { id: "hapi", name: "hapi" } },
  { names: ["hono"], category: "framework", framework: { id: "hono", name: "Hono" } },
  { names: ["fastify"], category: "framework", framework: { id: "fastify", name: "Fastify" } },
  { names: ["@nestjs/core", "@nestjs/common"], category: "framework", framework: { id: "nestjs", name: "NestJS" } },
  { names: ["@adonisjs/core"], category: "framework", framework: { id: "adonisjs", name: "AdonisJS" } },
  { names: ["@feathersjs/feathers"], category: "framework", framework: { id: "feathers", name: "Feathers" } },
  { names: ["sails"], category: "framework", framework: { id: "sails", name: "Sails.js" } },
  { names: ["@trpc/server", "@trpc/client"], category: "graphql", framework: { id: "trpc", name: "tRPC" } },

  // ── ORMs / query builders ──
  { names: ["prisma", "@prisma/client"], category: "orm" },
  { names: ["typeorm", "sequelize", "sequelize-typescript", "drizzle-orm", "@mikro-orm/core", "mongoose", "objection", "bookshelf"], category: "orm" },
  { names: ["knex", "kysely", "dynamoose", "@nestjs/typeorm", "@nestjs/mongoose", "@nestjs/sequelize"], category: "orm" },
  // ── Database drivers ──
  { names: ["pg", "postgres", "mysql", "mysql2", "mssql", "oracledb", "sqlite3", "better-sqlite3", "redis", "ioredis", "mongodb", "@elastic/elasticsearch", "cassandra-driver"], category: "database" },
  { names: ["@supabase/supabase-js", "firebase-admin", "@google-cloud/firestore", "@aws-sdk/lib-dynamodb", "@vercel/postgres", "@neondatabase/serverless", "@planetscale/database", "@libsql/client"], category: "database" },
  // ── HTTP clients ──
  { names: ["axios", "got", "node-fetch", "ky", "superagent", "undici"], category: "http" },
  // ── State management ──
  { names: ["redux", "@reduxjs/toolkit", "react-redux", "zustand", "jotai", "recoil", "mobx", "xstate"], category: "state" },
  { names: ["pinia", "vuex"], category: "state" },
  { names: ["@tanstack/react-query", "react-query", "@tanstack/vue-query", "swr"], category: "state" },
  // ── UI / component libraries ──
  { names: ["@mui/material", "@material-ui/core", "antd", "@chakra-ui/react", "tailwindcss", "bootstrap", "primevue", "primereact", "vuetify", "element-plus", "@mantine/core", "@shadcn/ui"], category: "ui" },
  // ── GraphQL / gRPC ──
  { names: ["graphql", "@apollo/client", "apollo-server", "@apollo/server", "@nestjs/graphql", "type-graphql", "urql"], category: "graphql" },
  { names: ["grpc", "@grpc/grpc-js"], category: "grpc" },
  // ── Messaging / queues ──
  { names: ["amqplib", "amqp-connection-manager"], category: "messaging", framework: { id: "rabbitmq", name: "RabbitMQ" } },
  { names: ["kafkajs", "node-rdkafka"], category: "messaging", framework: { id: "kafka", name: "Kafka" } },
  { names: ["bull", "bullmq", "nats", "@nestjs/microservices"], category: "messaging" },
  // ── Auth ──
  { names: ["passport", "jsonwebtoken", "bcrypt", "bcryptjs", "next-auth", "@auth/core", "oauth", "argon2"], category: "auth" },
  // ── Validation ──
  { names: ["zod", "yup", "joi", "class-validator", "ajv", "superstruct", "valibot"], category: "validation" },
  // ── Logging ──
  { names: ["winston", "pino", "bunyan", "log4js", "loglevel"], category: "logging" },
  // ── Serialization ──
  { names: ["protobufjs", "@bufbuild/protobuf", "avsc", "msgpackr"], category: "serialization" },
  // ── Cloud SDKs ──
  { names: ["aws-sdk", "@aws-sdk/client-s3", "@google-cloud/storage", "@azure/storage-blob", "firebase", "firebase-admin"], category: "cloud" },
  // ── Testing ──
  { names: ["jest", "vitest", "mocha", "chai", "jasmine", "karma", "cypress", "playwright", "@playwright/test", "puppeteer", "@testing-library/react", "@testing-library/vue", "supertest", "sinon", "ts-jest"], category: "testing" },
  // ── Build / bundlers / transpilers ──
  { names: ["webpack", "vite", "rollup", "esbuild", "parcel", "@babel/core", "babel", "tsup", "gulp", "grunt", "@swc/core", "turbo", "nx", "typescript", "ts-node", "nodemon"], category: "build" },
  // ── Linting / formatting ──
  { names: ["eslint", "prettier", "stylelint", "tslint", "standard", "biome", "@biomejs/biome"], category: "lint" },
  // ── Utility / date / reactive ──
  { names: ["lodash", "lodash-es", "ramda", "underscore", "immer", "uuid", "nanoid", "dayjs", "date-fns", "moment", "luxon", "rxjs"], category: "util" },
  // ── Build / dev tooling (beyond bundlers) ──
  { names: ["sass", "less", "postcss", "autoprefixer", "concurrently", "npm-run-all", "rimraf", "cross-env", "husky", "lint-staged", "dotenv"], category: "build" },
  // ── Realtime / messaging ──
  { names: ["socket.io", "socket.io-client", "ws"], category: "messaging" },
  // ── Serialization / parsing ──
  { names: ["js-yaml", "yaml", "papaparse", "xml2js", "fast-xml-parser"], category: "serialization" },
  // ── UI extras ──
  { names: ["@fortawesome/fontawesome-free", "@fortawesome/fontawesome-svg-core", "codemirror"], category: "ui" },

  // ── Family patterns (lower priority than the exacts above) ──
  { match: /^@aws-sdk\//, category: "cloud" },
  { match: /^@google-cloud\//, category: "cloud" },
  { match: /^@azure\//, category: "cloud" },
  { match: /^@sentry\//, category: "logging" },
  { match: /^@opentelemetry\//, category: "logging" },
  { match: /^@nestjs\//, category: "framework", framework: { id: "nestjs", name: "NestJS" } },
  { match: /^@angular\//, category: "frontend", framework: { id: "angular", name: "Angular" } },
  { match: /^@vue\//, category: "frontend" },
  { match: /^@codemirror\//, category: "ui" },
  { match: /^@babel\//, category: "build" },
  { match: /(^|\/)eslint-/, category: "lint" },
  { match: /^@typescript-eslint\//, category: "lint" },
  { match: /^@testing-library\//, category: "testing" },
  // ── Filesystem / cache / mail ──
  // `System.IO`-style breadth is deliberately avoided: these are packages whose
  // whole purpose is the boundary, not general-purpose namespaces.
  { names: ["fs", "node:fs", "fs/promises", "node:fs/promises", "fs-extra", "graceful-fs", "chokidar", "memfs"], category: "filesystem" },
  { names: ["lru-cache", "node-cache", "cache-manager", "keyv", "@vercel/kv", "@upstash/redis"], category: "cache" },
  { names: ["nodemailer", "@sendgrid/mail", "postmark", "mailgun.js", "resend", "@aws-sdk/client-ses"], category: "email" },

];
