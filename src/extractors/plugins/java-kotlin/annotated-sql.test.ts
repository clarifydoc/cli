import { describe, it, expect } from "vitest";
import "../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../parsers/parser-manager.js";
import { JavaKotlinDataSourceExtractor } from "./data-sources.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";

/**
 * A repository method whose SQL is its annotation has no call to read: the
 * statement in `@Query(…)` is the only place the table is named. Room DAOs and
 * Spring Data repositories are interfaces made of nothing else, so without
 * this the table end of every Android and most Spring chains was missing.
 */
async function dbRows(src: string, lang: Language, file: string): Promise<string[]> {
  const tree = await parseSource(src, lang as any, file);
  const rows: DataSourceInfo[] = new JavaKotlinDataSourceExtractor().extract(tree, src);
  return rows.filter((d) => d.kind === "database").map((d) => `${d.name} ${d.access ?? "?"} ${d.target}@${d.line}`);
}

describe("SQL in repository annotations", () => {
  it("reads Room @Query SQL and the entity a SQL-less @Insert/@Delete takes (Kotlin)", async () => {
    const SRC = `package app.data
import androidx.room.*

@Dao
interface DrillDao {
    @Query("SELECT * FROM drills ORDER BY id")
    fun all(): List<Drill>

    @Query("""
        UPDATE drills
        SET done = 1
        WHERE id = :id
    """)
    fun complete(id: Long)

    @Insert
    fun insertAll(drills: List<Drill>)

    @Delete
    fun remove(drill: Drill)
}`;
    expect(await dbRows(SRC, "kotlin", "DrillDao.kt")).toEqual([
      "@Query read drills@7",
      "@Query write drills@14",
      "@Insert write Drill@17",
      "@Delete write Drill@20",
    ]);
  });

  it("reads Spring Data @Query in JPQL and native SQL, joined across concatenation (Java)", async () => {
    const SRC = `package x;
import org.springframework.data.jpa.repository.*;

public interface CarRepository extends JpaRepository<Car, Long> {
  @Query("SELECT o FROM Car o WHERE o.driver.id = :id")
  List<Car> forDriver(Long id);

  @Modifying
  @Query(value = "DELETE FROM car_parts " + "WHERE car_id = ?1", nativeQuery = true)
  void dropParts(Long id);
}`;
    expect(await dbRows(SRC, "java", "CarRepository.java")).toEqual([
      "@Query read Car@6",
      "@Query write car_parts@10",
    ]);
  });

  it("ignores annotations that are not SQL, and Room write verbs outside Room", async () => {
    const SRC = `package x;
import javax.ws.rs.*;

public interface Api {
  @Query("search")
  String find(String q);

  @Delete
  void remove(Ball ball);
}`;
    expect(await dbRows(SRC, "java", "Api.java")).toEqual([]);
  });
});
