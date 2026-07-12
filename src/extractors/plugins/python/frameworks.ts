import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasPythonDep } from "../shared/project-info-queries.js";

/** Python framework rules — web frameworks and ORMs via requirements/pyproject. */
export const pythonFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "fastapi",
    name: "FastAPI",
    check: (info) => hasPythonDep(info, "fastapi"),
    detectedVia: "Python manifest",
  },
  {
    id: "django",
    name: "Django",
    check: (info) => hasPythonDep(info, "django"),
    detectedVia: "Python manifest",
  },
  {
    id: "flask",
    name: "Flask",
    check: (info) => hasPythonDep(info, "flask"),
    detectedVia: "Python manifest",
  },
  // ORMs
  {
    id: "sqlalchemy",
    name: "SQLAlchemy",
    check: (info) => hasPythonDep(info, "sqlalchemy"),
    detectedVia: "Python manifest",
  },
  {
    id: "django-orm",
    name: "Django ORM",
    check: (info) => hasPythonDep(info, "django"),
    detectedVia: "Python manifest",
  },
  {
    id: "tortoise-orm",
    name: "Tortoise ORM",
    check: (info) => hasPythonDep(info, "tortoise"),
    detectedVia: "Python manifest",
  },
  {
    id: "peewee",
    name: "Peewee",
    check: (info) => hasPythonDep(info, "peewee"),
    detectedVia: "Python manifest",
  },
];
