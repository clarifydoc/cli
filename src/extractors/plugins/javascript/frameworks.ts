import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasDep } from "../shared/project-info-queries.js";

/**
 * npm-ecosystem framework rules (web frameworks, state management, JS ORMs).
 * Family plugin: attached to `typescriptMeta` only so the registry aggregates
 * each rule once. Prisma lives with the prisma plugin (it owns that domain).
 */
export const javascriptFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "react",
    name: "React",
    check: (info) => hasDep(info, "react"),
    detectedVia: "package.json dependency",
  },
  {
    id: "react-router",
    name: "React Router",
    check: (info) =>
      hasDep(info, "react-router-dom") || hasDep(info, "react-router"),
    detectedVia: "package.json dependency",
  },
  {
    id: "nextjs",
    name: "Next.js",
    check: (info) => hasDep(info, "next"),
    detectedVia: "package.json dependency",
  },
  {
    id: "expo-router",
    name: "Expo Router",
    check: (info) => hasDep(info, "expo-router"),
    detectedVia: "package.json dependency",
  },
  {
    id: "vue",
    name: "Vue",
    check: (info) => hasDep(info, "vue"),
    detectedVia: "package.json dependency",
  },
  {
    id: "vue-router",
    name: "Vue Router",
    check: (info) => hasDep(info, "vue-router"),
    detectedVia: "package.json dependency",
  },
  {
    id: "angular",
    name: "Angular",
    check: (info) => hasDep(info, "@angular/core"),
    detectedVia: "package.json dependency",
  },
  {
    id: "svelte",
    name: "Svelte",
    check: (info) => hasDep(info, "svelte") || hasDep(info, "@sveltejs/kit"),
    detectedVia: "package.json dependency",
  },
  {
    id: "express",
    name: "Express",
    check: (info) => hasDep(info, "express"),
    detectedVia: "package.json dependency",
  },
  {
    id: "nestjs",
    name: "NestJS",
    check: (info) => hasDep(info, "@nestjs/core"),
    detectedVia: "package.json dependency",
  },
  {
    id: "fastify",
    name: "Fastify",
    check: (info) => hasDep(info, "fastify"),
    detectedVia: "package.json dependency",
  },
  {
    id: "quasar",
    name: "Quasar",
    check: (info) => hasDep(info, "quasar") || hasDep(info, "@quasar/app-vite") || hasDep(info, "@quasar/app-webpack"),
    detectedVia: "package.json dependency",
  },
  {
    id: "nuxt",
    name: "Nuxt",
    check: (info) => hasDep(info, "nuxt") || hasDep(info, "nuxt3") || hasDep(info, "nuxt-edge"),
    detectedVia: "package.json dependency",
  },
  // State management
  {
    id: "vuex",
    name: "Vuex",
    check: (info) => hasDep(info, "vuex"),
    detectedVia: "package.json dependency",
  },
  {
    id: "pinia",
    name: "Pinia",
    check: (info) => hasDep(info, "pinia"),
    detectedVia: "package.json dependency",
  },
  {
    id: "redux",
    name: "Redux",
    check: (info) => hasDep(info, "redux") || hasDep(info, "@reduxjs/toolkit") || hasDep(info, "react-redux"),
    detectedVia: "package.json dependency",
  },
  {
    id: "zustand",
    name: "Zustand",
    check: (info) => hasDep(info, "zustand"),
    detectedVia: "package.json dependency",
  },
  {
    id: "react-query",
    name: "React Query",
    check: (info) => hasDep(info, "@tanstack/react-query") || hasDep(info, "react-query"),
    detectedVia: "package.json dependency",
  },
  // ORMs
  {
    id: "typeorm",
    name: "TypeORM",
    check: (info) => hasDep(info, "typeorm"),
    detectedVia: "package.json dependency",
  },
  {
    id: "sequelize",
    name: "Sequelize",
    check: (info) => hasDep(info, "sequelize") || hasDep(info, "sequelize-typescript"),
    detectedVia: "package.json dependency",
  },
  {
    id: "drizzle",
    name: "Drizzle ORM",
    check: (info) => hasDep(info, "drizzle-orm"),
    detectedVia: "package.json dependency",
  },
  {
    id: "mikro-orm",
    name: "MikroORM",
    check: (info) => hasDep(info, "@mikro-orm/core"),
    detectedVia: "package.json dependency",
  },
  {
    id: "mongoose",
    name: "Mongoose",
    check: (info) => hasDep(info, "mongoose"),
    detectedVia: "package.json dependency",
  },
  {
    id: "knex",
    name: "Knex",
    check: (info) => hasDep(info, "knex"),
    detectedVia: "package.json dependency",
  },
  {
    id: "objection",
    name: "Objection.js",
    check: (info) => hasDep(info, "objection"),
    detectedVia: "package.json dependency",
  },
];
