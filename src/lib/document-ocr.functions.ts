import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { requireAuth } from "./data.functions";

const InputSchema = z.object({
  base64: z.string().min(10),
  mimeType: z.string().min(3).max(100),
  tipo: z.string().min(1).max(100),
});

const TOOL = {
  type: "function" as const,
  function: {
    name: "extract_documento",
    description:
      "Extrai os campos relevantes de um documento pessoal/trabalhista brasileiro.",
    parameters: {
      type: "object",
      properties: {
        nome_completo: { type: "string" },
        cpf: {
          type: "string",
          description: "Apenas dígitos ou formato ###.###.###-##",
        },
        rg: { type: "string" },
        orgao_emissor: { type: "string" },
        data_nascimento: { type: "string", description: "YYYY-MM-DD" },
        data_emissao: { type: "string", description: "YYYY-MM-DD" },
        data_validade: { type: "string", description: "YYYY-MM-DD" },
        numero_documento: {
          type: "string",
          description: "Número principal do documento (CTPS, conta, etc.)",
        },
        endereco: { type: "string" },
        observacoes: {
          type: "string",
          description: "Resumo curto do que o documento contém",
        },
        confianca: { type: "number", description: "0 a 1" },
      },
      required: ["confianca"],
      additionalProperties: false,
    },
  },
};

export const extractDocumentoOCR = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => parseInput(InputSchema, d))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey)
      return { ok: false as const, error: "LOVABLE_API_KEY ausente" };

    const isPdf = data.mimeType === "application/pdf";
    const userContent = isPdf
      ? [
          {
            type: "text",
            text: `Extraia os campos do documento "${data.tipo}" anexado (PDF) usando a função fornecida.`,
          },
          {
            type: "file",
            file: {
              filename: "doc.pdf",
              file_data: `data:application/pdf;base64,${data.base64}`,
            },
          },
        ]
      : [
          {
            type: "text",
            text: `Extraia os campos do documento "${data.tipo}" nesta imagem usando a função fornecida.`,
          },
          {
            type: "image_url",
            image_url: { url: `data:${data.mimeType};base64,${data.base64}` },
          },
        ];

    try {
      const res = await fetch(
        "https://ai.gateway.lovable.dev/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              {
                role: "system",
                content:
                  "Você lê documentos brasileiros (RG, CPF, CTPS, comprovantes, contratos, ASO). Omita campos que não aparecem.",
              },
              { role: "user", content: userContent },
            ],
            tools: [TOOL],
            tool_choice: {
              type: "function",
              function: { name: "extract_documento" },
            },
          }),
        },
      );
      if (res.status === 429)
        return { ok: false as const, error: "Limite de uso atingido." };
      if (res.status === 402)
        return { ok: false as const, error: "Créditos de IA esgotados." };
      if (!res.ok) {
        console.error("OCR doc gateway error", res.status, await res.text());
        return { ok: false as const, error: `Falha na IA (${res.status})` };
      }
      const json = await res.json();
      const call = json.choices?.[0]?.message?.tool_calls?.[0];
      if (!call?.function?.arguments)
        return {
          ok: false as const,
          error: "Não foi possível extrair os campos.",
        };
      const fields = JSON.parse(call.function.arguments);
      return { ok: true as const, fields };
    } catch (e) {
      console.error("OCR doc error", e);
      return { ok: false as const, error: "Erro inesperado no OCR." };
    }
  });
