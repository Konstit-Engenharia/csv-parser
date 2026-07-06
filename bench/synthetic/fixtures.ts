export function makeUtf8Fixture(rows: number): Buffer {
  return Buffer.from(makeLatin1Text(rows));
}

export function makeLatin1Text(rows: number): string {
  let output = 'id,nome,cidade,valor\n';
  for (let i = 0; i < rows; ++i) {
    output += `${i},João ${i},"São Paulo, SP",${i % 997}\n`;
  }
  return output;
}
