export function liveSource(line: number): string {
  return "# 😀é\r\n".repeat(line) + 'value: "😀 {{ value\r\n }}"\r\n';
}

export function liveContext(): string {
  return Array.from(
    { length: 4000 },
    (_, index) => `livecontext_role_value_${index}: ${index}\n`,
  ).join("");
}

export const liveTemplate =
  " \t😀\r\n{% raw -%}{{ {% unmatched{%- endraw %}\r\n{{ lookup('role_var', '_port', role='navtarget') }}  ";
