import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { parseInput } from "./input-validation";
import { requireAuth } from "./data.functions";

const InputSchema = z.object({
  base64: z.string().min(10),
  mimeType: z.string().min(3).max(100),
});

const OCR_TOOL = {
  type: "function" as const,
  function: {
    name: "extract_atestado",
    description:
      "Extrai os campos estruturados de um atestado médico brasileiro.",
    parameters: {
      type: "object",
      properties: {
        paciente_nome: {
          type: "string",
          description: "Nome completo do paciente",
        },
        cpf: {
          type: "string",
          description:
            "CPF do paciente, apenas dígitos ou formato ###.###.###-##",
        },
        matricula: {
          type: "string",
          description: "Matrícula do funcionário, se constar",
        },
        data_emissao: {
          type: "string",
          description: "Data de emissão no formato YYYY-MM-DD",
        },
        data_inicio: {
          type: "string",
          description: "Data inicial do afastamento YYYY-MM-DD",
        },
        data_fim: {
          type: "string",
          description: "Data final do afastamento YYYY-MM-DD",
        },
        dias_afastamento: {
          type: "number",
          description: "Quantidade de dias de afastamento",
        },
        medico_nome: { type: "string", description: "Nome do médico" },
        medico_crm: {
          type: "string",
          description: "CRM do médico, com UF se houver",
        },
        cid: {
          type: "string",
          description: "Código CID-10 (ex: J06.9). Vazio se não constar.",
        },
        observacoes: {
          type: "string",
          description: "Outras observações relevantes",
        },
        confianca: {
          type: "number",
          description: "0 a 1, sua confiança na extração",
        },
      },
      required: ["confianca"],
      additionalProperties: false,
    },
  },
};

export const extractAtestadoOCR = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((d: unknown) => parseInput(InputSchema, d))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) {
      return { ok: false as const, error: "LOVABLE_API_KEY ausente" };
    }

    const isPdf = data.mimeType === "application/pdf";
    const userContent = isPdf
      ? [
          {
            type: "text",
            text: "Extraia os campos do atestado médico anexado (PDF) usando a função fornecida.",
          },
          {
            type: "file",
            file: {
              filename: "atestado.pdf",
              file_data: `data:application/pdf;base64,${data.base64}`,
            },
          },
        ]
      : [
          {
            type: "text",
            text: "Extraia os campos do atestado médico nesta imagem usando a função fornecida.",
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
                  "Você é um assistente especializado em ler atestados médicos brasileiros. Seja preciso com datas e CIDs. Quando um campo não estiver visível, omita-o.",
              },
              { role: "user", content: userContent },
            ],
            tools: [OCR_TOOL],
            tool_choice: {
              type: "function",
              function: { name: "extract_atestado" },
            },
          }),
        },
      );

      if (res.status === 429)
        return {
          ok: false as const,
          error: "Limite de uso atingido. Tente novamente em alguns instantes.",
        };
      if (res.status === 402)
        return {
          ok: false as const,
          error: "Créditos de IA esgotados no workspace.",
        };
      if (!res.ok) {
        const t = await res.text();
        console.error("OCR gateway error", res.status, t);
        return { ok: false as const, error: `Falha na IA (${res.status})` };
      }

      const json = await res.json();
      const call = json.choices?.[0]?.message?.tool_calls?.[0];
      if (!call?.function?.arguments) {
        return {
          ok: false as const,
          error: "Não foi possível extrair os campos.",
        };
      }
      const fields = JSON.parse(call.function.arguments);
      return { ok: true as const, fields };
    } catch (e) {
      console.error("OCR error", e);
      return { ok: false as const, error: "Erro inesperado no OCR." };
    }
  });
