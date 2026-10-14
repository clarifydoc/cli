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
interface TodoDao {
    @Query("SELECT * FROM todos ORDER BY id")
    fun all(): List<Todo>

    @Query("""
        UPDATE todos
        SET done = 1
        WHERE id = :id
    """)
    fun complete(id: Long)

    @Insert
    fun insertAll(todos: List<Todo>)

    @Delete
    fun remove(todo: Todo)
}`;
    expect(await dbRows(SRC, "kotlin", "TodoDao.kt")).toEqual([
      "@Query read todos@7",
      "@Query write todos@14",
      "@Insert write Todo@17",
      "@Delete write Todo@20",
    ]);
  });

  it("reads Spring Data @Query in JPQL and native SQL, joined across concatenation (Java)", async () => {
    const SRC = `package x;
import org.springframework.data.jpa.repository.*;

public interface OrderRepository extends JpaRepository<Order, Long> {
  @Query("SELECT o FROM Order o WHERE o.customer.id = :id")
  List<Order> forCustomer(Long id);

  @Modifying
  @Query(value = "DELETE FROM order_lines " + "WHERE order_id = ?1", nativeQuery = true)
  void dropLines(Long id);
}`;
    expect(await dbRows(SRC, "java", "OrderRepository.java")).toEqual([
      "@Query read Order@6",
      "@Query write order_lines@10",
    ]);
  });

  it("ignores annotations that are not SQL, and Room write verbs outside Room", async () => {
    const SRC = `package x;
import javax.ws.rs.*;

public interface Api {
  @Query("search")
  String find(String q);

  @Delete
  void remove(Item item);
}`;
    expect(await dbRows(SRC, "java", "Api.java")).toEqual([]);
  });
});
