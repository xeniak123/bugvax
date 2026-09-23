import { extname } from "node:path";

export interface LanguageInfo {
  /** Language id written into antibody rules (an ast-grep language name). */
  id: string;
  label: string;
  exts: string[];
  /** Common tree-sitter node kinds, given to the model as a hint. */
  kinds: string;
}

/**
 * JavaScript and TypeScript files are all parsed with the TSX grammar (see `languageGlobs` in the
 * engine), so one antibody covers .js, .jsx, .ts and .tsx alike.
 */
export const LANGUAGES: LanguageInfo[] = [
  {
    id: "tsx",
    label: "JavaScript/TypeScript",
    exts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    kinds:
      "call_expression, member_expression, await_expression, arrow_function, function_declaration, method_definition, " +
      "if_statement, return_statement, lexical_declaration, variable_declarator, try_statement, catch_clause, " +
      "binary_expression, unary_expression, new_expression, object, pair, array, identifier, property_identifier, " +
      "string, template_string, jsx_element, jsx_self_closing_element, jsx_attribute, statement_block, expression_statement",
  },
  {
    id: "python",
    label: "Python",
    exts: [".py", ".pyi"],
    kinds:
      "call, attribute, identifier, argument_list, keyword_argument, function_definition, parameters, default_parameter, " +
      "typed_default_parameter, if_statement, return_statement, try_statement, except_clause, with_statement, " +
      "assignment, comparison_operator, boolean_operator, await, for_statement, list, dictionary, set, string, " +
      "decorated_definition, block, expression_statement, none",
  },
  {
    id: "go",
    label: "Go",
    exts: [".go"],
    kinds:
      "call_expression, selector_expression, if_statement, short_var_declaration, assignment_statement, " +
      "return_statement, function_declaration, method_declaration, defer_statement, go_statement, binary_expression, " +
      "expression_list, identifier, field_identifier, block, for_statement, nil",
  },
  { id: "rust", label: "Rust", exts: [".rs"], kinds: "call_expression, field_expression, macro_invocation, let_declaration, if_expression, match_expression, try_expression, unsafe_block, function_item, identifier" },
  { id: "java", label: "Java", exts: [".java"], kinds: "method_invocation, object_creation_expression, field_access, if_statement, try_statement, catch_clause, method_declaration, local_variable_declaration, binary_expression, identifier" },
  { id: "kotlin", label: "Kotlin", exts: [".kt", ".kts"], kinds: "call_expression, navigation_expression, if_expression, function_declaration, property_declaration, simple_identifier" },
  { id: "ruby", label: "Ruby", exts: [".rb"], kinds: "call, method, if, unless, begin, rescue, assignment, identifier, constant" },
  { id: "php", label: "PHP", exts: [".php"], kinds: "function_call_expression, member_call_expression, if_statement, method_declaration, assignment_expression, variable_name, name" },
  { id: "csharp", label: "C#", exts: [".cs"], kinds: "invocation_expression, member_access_expression, if_statement, method_declaration, using_statement, await_expression, identifier" },
  { id: "swift", label: "Swift", exts: [".swift"], kinds: "call_expression, navigation_expression, if_statement, guard_statement, function_declaration, simple_identifier" },
  { id: "c", label: "C", exts: [".c", ".h"], kinds: "call_expression, field_expression, if_statement, declaration, assignment_expression, return_statement, identifier" },
  { id: "cpp", label: "C++", exts: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"], kinds: "call_expression, field_expression, if_statement, declaration, new_expression, delete_expression, identifier" },
  { id: "scala", label: "Scala", exts: [".scala"], kinds: "call_expression, field_expression, if_expression, function_definition, val_definition, identifier" },
  { id: "lua", label: "Lua", exts: [".lua"], kinds: "function_call, dot_index_expression, if_statement, function_declaration, identifier" },
  { id: "elixir", label: "Elixir", exts: [".ex", ".exs"], kinds: "call, dot, identifier, atom, do_block" },
];

const BY_EXT = new Map<string, LanguageInfo>();
for (const l of LANGUAGES) for (const e of l.exts) BY_EXT.set(e, l);
const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));

export function languageOf(path: string): LanguageInfo | undefined {
  return BY_EXT.get(extname(path).toLowerCase());
}

export function languageById(id: string): LanguageInfo | undefined {
  return BY_ID.get(id.toLowerCase());
}

/** Globs that make ast-grep parse every JS/TS file with the TSX grammar. */
export const TSX_GLOBS = LANGUAGES[0].exts.map((e) => `*${e}`);

const TEST_PATH = /(^|\/)(__tests__|__mocks__|tests?|spec|specs|e2e|fixtures?|testdata)\//i;
const TEST_FILE = /(\.(test|spec|e2e)\.[a-z]+$)|(_test\.(go|py|rb|exs?)$)|((^|\/)test_[^/]+\.py$)|((^|\/)conftest\.py$)|(Tests?\.(java|kt|cs|swift)$)/i;

export function isTestFile(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return TEST_PATH.test(p) || TEST_FILE.test(p);
}

const VENDOR_PATH = /(^|\/)(node_modules|vendor|third_party|dist|build|out|\.next|coverage|__generated__|generated)\//i;
const GENERATED_FILE = /(\.min\.[a-z]+$)|(\.d\.ts$)|(\.pb\.go$)|(_pb2\.py$)|(\.generated\.[a-z]+$)/i;

export function isVendoredOrGenerated(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return VENDOR_PATH.test(p) || GENERATED_FILE.test(p);
}
