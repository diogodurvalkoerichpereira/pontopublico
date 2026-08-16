export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      atestados: {
        Row: {
          arquivo_mime: string | null
          arquivo_path: string
          cid: string | null
          cpf: string | null
          created_at: string
          data_emissao: string | null
          data_fim: string | null
          data_inicio: string | null
          dias_afastamento: number | null
          id: string
          matricula: string | null
          medico_crm: string | null
          medico_nome: string | null
          observacoes: string | null
          ocr_confianca: number | null
          ocr_raw: Json | null
          paciente_nome: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          rh_observacao: string | null
          status: Database["public"]["Enums"]["atestado_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          arquivo_mime?: string | null
          arquivo_path: string
          cid?: string | null
          cpf?: string | null
          created_at?: string
          data_emissao?: string | null
          data_fim?: string | null
          data_inicio?: string | null
          dias_afastamento?: number | null
          id?: string
          matricula?: string | null
          medico_crm?: string | null
          medico_nome?: string | null
          observacoes?: string | null
          ocr_confianca?: number | null
          ocr_raw?: Json | null
          paciente_nome?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          rh_observacao?: string | null
          status?: Database["public"]["Enums"]["atestado_status"]
          updated_at?: string
          user_id: string
        }
        Update: {
          arquivo_mime?: string | null
          arquivo_path?: string
          cid?: string | null
          cpf?: string | null
          created_at?: string
          data_emissao?: string | null
          data_fim?: string | null
          data_inicio?: string | null
          dias_afastamento?: number | null
          id?: string
          matricula?: string | null
          medico_crm?: string | null
          medico_nome?: string | null
          observacoes?: string | null
          ocr_confianca?: number | null
          ocr_raw?: Json | null
          paciente_nome?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          rh_observacao?: string | null
          status?: Database["public"]["Enums"]["atestado_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          atestado_id: string | null
          created_at: string
          id: string
          metadata: Json | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          atestado_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          atestado_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_atestado_id_fkey"
            columns: ["atestado_id"]
            isOneToOne: false
            referencedRelation: "atestados"
            referencedColumns: ["id"]
          },
        ]
      }
      document_checklist: {
        Row: {
          categoria: Database["public"]["Enums"]["documento_categoria"]
          created_at: string
          document_id: string | null
          id: string
          obrigatorio: boolean
          tipo: string
          user_id: string
        }
        Insert: {
          categoria: Database["public"]["Enums"]["documento_categoria"]
          created_at?: string
          document_id?: string | null
          id?: string
          obrigatorio?: boolean
          tipo: string
          user_id: string
        }
        Update: {
          categoria?: Database["public"]["Enums"]["documento_categoria"]
          created_at?: string
          document_id?: string | null
          id?: string
          obrigatorio?: boolean
          tipo?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_checklist_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "employee_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_documents: {
        Row: {
          arquivo_mime: string | null
          arquivo_path: string
          categoria: Database["public"]["Enums"]["documento_categoria"]
          created_at: string
          descricao: string | null
          id: string
          observacao_rh: string | null
          ocr_dados: Json | null
          ocr_raw: Json | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: Database["public"]["Enums"]["documento_status"]
          tipo: string
          updated_at: string
          user_id: string
        }
        Insert: {
          arquivo_mime?: string | null
          arquivo_path: string
          categoria: Database["public"]["Enums"]["documento_categoria"]
          created_at?: string
          descricao?: string | null
          id?: string
          observacao_rh?: string | null
          ocr_dados?: Json | null
          ocr_raw?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["documento_status"]
          tipo: string
          updated_at?: string
          user_id: string
        }
        Update: {
          arquivo_mime?: string | null
          arquivo_path?: string
          categoria?: Database["public"]["Enums"]["documento_categoria"]
          created_at?: string
          descricao?: string | null
          id?: string
          observacao_rh?: string | null
          ocr_dados?: Json | null
          ocr_raw?: Json | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: Database["public"]["Enums"]["documento_status"]
          tipo?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          atestado_id: string | null
          created_at: string
          id: string
          lida: boolean
          mensagem: string
          tipo: string
          titulo: string
          user_id: string
        }
        Insert: {
          atestado_id?: string | null
          created_at?: string
          id?: string
          lida?: boolean
          mensagem: string
          tipo: string
          titulo: string
          user_id: string
        }
        Update: {
          atestado_id?: string | null
          created_at?: string
          id?: string
          lida?: boolean
          mensagem?: string
          tipo?: string
          titulo?: string
          user_id?: string
        }
        Relationships: []
      }
      payroll_config: {
        Row: {
          deducao_dependente: number
          id: string
          inss_faixas: Json
          irrf_faixas: Json
          salario_minimo: number
          teto_inss: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          deducao_dependente?: number
          id?: string
          inss_faixas?: Json
          irrf_faixas?: Json
          salario_minimo?: number
          teto_inss?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          deducao_dependente?: number
          id?: string
          inss_faixas?: Json
          irrf_faixas?: Json
          salario_minimo?: number
          teto_inss?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      payroll_periods: {
        Row: {
          adicional_insalubridade: number
          adicional_noturno_valor: number
          adicional_periculosidade: number
          calculated_at: string | null
          closed_at: string | null
          closed_by: string | null
          created_at: string
          desconto_faltas: number
          desconto_vt: number
          dias_trabalhados: number
          fgts: number
          horas_extras_100: number
          horas_extras_50: number
          horas_faltantes: number
          horas_previstas: number
          horas_trabalhadas: number
          id: string
          inss: number
          irrf: number
          observacao: string | null
          outros_descontos: number
          outros_proventos: number
          plano_saude: number
          ref_month: string
          salario_base: number
          salario_final: number
          salario_minimo_ref: number
          status: Database["public"]["Enums"]["payroll_status"]
          total_descontos: number
          total_proventos: number
          updated_at: string
          user_id: string
          vale_alimentacao_total: number
          vale_transporte_total: number
          valor_extras: number
        }
        Insert: {
          adicional_insalubridade?: number
          adicional_noturno_valor?: number
          adicional_periculosidade?: number
          calculated_at?: string | null
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          desconto_faltas?: number
          desconto_vt?: number
          dias_trabalhados?: number
          fgts?: number
          horas_extras_100?: number
          horas_extras_50?: number
          horas_faltantes?: number
          horas_previstas?: number
          horas_trabalhadas?: number
          id?: string
          inss?: number
          irrf?: number
          observacao?: string | null
          outros_descontos?: number
          outros_proventos?: number
          plano_saude?: number
          ref_month: string
          salario_base?: number
          salario_final?: number
          salario_minimo_ref?: number
          status?: Database["public"]["Enums"]["payroll_status"]
          total_descontos?: number
          total_proventos?: number
          updated_at?: string
          user_id: string
          vale_alimentacao_total?: number
          vale_transporte_total?: number
          valor_extras?: number
        }
        Update: {
          adicional_insalubridade?: number
          adicional_noturno_valor?: number
          adicional_periculosidade?: number
          calculated_at?: string | null
          closed_at?: string | null
          closed_by?: string | null
          created_at?: string
          desconto_faltas?: number
          desconto_vt?: number
          dias_trabalhados?: number
          fgts?: number
          horas_extras_100?: number
          horas_extras_50?: number
          horas_faltantes?: number
          horas_previstas?: number
          horas_trabalhadas?: number
          id?: string
          inss?: number
          irrf?: number
          observacao?: string | null
          outros_descontos?: number
          outros_proventos?: number
          plano_saude?: number
          ref_month?: string
          salario_base?: number
          salario_final?: number
          salario_minimo_ref?: number
          status?: Database["public"]["Enums"]["payroll_status"]
          total_descontos?: number
          total_proventos?: number
          updated_at?: string
          user_id?: string
          vale_alimentacao_total?: number
          vale_transporte_total?: number
          valor_extras?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          adicional_noturno: boolean
          cargo: string | null
          centro_custo: string | null
          contato_emergencia_nome: string | null
          contato_emergencia_telefone: string | null
          cpf: string | null
          created_at: string
          data_admissao: string | null
          dependentes_ir: number
          desconta_inss: boolean
          desconta_irrf: boolean
          desconto_vt_funcionario: boolean
          email: string | null
          endereco: string | null
          full_name: string | null
          gestor_id: string | null
          id: string
          insalubridade_pct: number
          matricula: string | null
          operacao: string | null
          outros_descontos: number
          outros_proventos: number
          periculosidade_pct: number
          plano_saude_desconto: number
          salario: number | null
          schedule_id: string | null
          setor: string | null
          status: Database["public"]["Enums"]["employee_status"]
          telefone: string | null
          tipo_ponto: Database["public"]["Enums"]["ponto_tipo"]
          updated_at: string
          vale_alimentacao_diario: number | null
          vale_transporte_diario: number | null
          valor_hora: number | null
        }
        Insert: {
          adicional_noturno?: boolean
          cargo?: string | null
          centro_custo?: string | null
          contato_emergencia_nome?: string | null
          contato_emergencia_telefone?: string | null
          cpf?: string | null
          created_at?: string
          data_admissao?: string | null
          dependentes_ir?: number
          desconta_inss?: boolean
          desconta_irrf?: boolean
          desconto_vt_funcionario?: boolean
          email?: string | null
          endereco?: string | null
          full_name?: string | null
          gestor_id?: string | null
          id: string
          insalubridade_pct?: number
          matricula?: string | null
          operacao?: string | null
          outros_descontos?: number
          outros_proventos?: number
          periculosidade_pct?: number
          plano_saude_desconto?: number
          salario?: number | null
          schedule_id?: string | null
          setor?: string | null
          status?: Database["public"]["Enums"]["employee_status"]
          telefone?: string | null
          tipo_ponto?: Database["public"]["Enums"]["ponto_tipo"]
          updated_at?: string
          vale_alimentacao_diario?: number | null
          vale_transporte_diario?: number | null
          valor_hora?: number | null
        }
        Update: {
          adicional_noturno?: boolean
          cargo?: string | null
          centro_custo?: string | null
          contato_emergencia_nome?: string | null
          contato_emergencia_telefone?: string | null
          cpf?: string | null
          created_at?: string
          data_admissao?: string | null
          dependentes_ir?: number
          desconta_inss?: boolean
          desconta_irrf?: boolean
          desconto_vt_funcionario?: boolean
          email?: string | null
          endereco?: string | null
          full_name?: string | null
          gestor_id?: string | null
          id?: string
          insalubridade_pct?: number
          matricula?: string | null
          operacao?: string | null
          outros_descontos?: number
          outros_proventos?: number
          periculosidade_pct?: number
          plano_saude_desconto?: number
          salario?: number | null
          schedule_id?: string | null
          setor?: string | null
          status?: Database["public"]["Enums"]["employee_status"]
          telefone?: string | null
          tipo_ponto?: Database["public"]["Enums"]["ponto_tipo"]
          updated_at?: string
          vale_alimentacao_diario?: number | null
          vale_transporte_diario?: number | null
          valor_hora?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_gestor_id_fkey"
            columns: ["gestor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "work_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      rh_permissions: {
        Row: {
          created_at: string
          granted_by: string | null
          id: string
          permission: Database["public"]["Enums"]["rh_permission"]
          user_id: string
        }
        Insert: {
          created_at?: string
          granted_by?: string | null
          id?: string
          permission: Database["public"]["Enums"]["rh_permission"]
          user_id: string
        }
        Update: {
          created_at?: string
          granted_by?: string | null
          id?: string
          permission?: Database["public"]["Enums"]["rh_permission"]
          user_id?: string
        }
        Relationships: []
      }
      time_entries: {
        Row: {
          created_at: string
          created_by: string | null
          entry_at: string
          id: string
          observacao: string | null
          origem: string
          tipo: Database["public"]["Enums"]["ponto_batida"]
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          entry_at?: string
          id?: string
          observacao?: string | null
          origem?: string
          tipo: Database["public"]["Enums"]["ponto_batida"]
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          entry_at?: string
          id?: string
          observacao?: string | null
          origem?: string
          tipo?: Database["public"]["Enums"]["ponto_batida"]
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      work_schedules: {
        Row: {
          carga_horaria_mensal: number
          config: Json
          created_at: string
          created_by: string | null
          id: string
          nome: string
          tipo: Database["public"]["Enums"]["schedule_type"]
          updated_at: string
        }
        Insert: {
          carga_horaria_mensal?: number
          config: Json
          created_at?: string
          created_by?: string | null
          id?: string
          nome: string
          tipo: Database["public"]["Enums"]["schedule_type"]
          updated_at?: string
        }
        Update: {
          carga_horaria_mensal?: number
          config?: Json
          created_at?: string
          created_by?: string | null
          id?: string
          nome?: string
          tipo?: Database["public"]["Enums"]["schedule_type"]
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_permission: {
        Args: {
          _perm: Database["public"]["Enums"]["rh_permission"]
          _user_id: string
        }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "funcionario" | "rh" | "admin"
      atestado_status: "pendente" | "aprovado" | "rejeitado"
      documento_categoria:
        | "identificacao_pessoal"
        | "trabalhista"
        | "comprovante"
        | "livre"
      documento_status: "pendente" | "aprovado" | "rejeitado"
      employee_status: "ativo" | "ferias" | "afastado" | "desligado"
      payroll_status: "aberto" | "fechado"
      ponto_batida: "entrada" | "saida_almoco" | "volta_almoco" | "saida"
      ponto_tipo: "2_batidas" | "4_batidas"
      rh_permission:
        | "manage_employees"
        | "approve_documents"
        | "configure_schedules"
        | "close_payroll"
      schedule_type: "fixed_weekly" | "rotative"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["funcionario", "rh", "admin"],
      atestado_status: ["pendente", "aprovado", "rejeitado"],
      documento_categoria: [
        "identificacao_pessoal",
        "trabalhista",
        "comprovante",
        "livre",
      ],
      documento_status: ["pendente", "aprovado", "rejeitado"],
      employee_status: ["ativo", "ferias", "afastado", "desligado"],
      payroll_status: ["aberto", "fechado"],
      ponto_batida: ["entrada", "saida_almoco", "volta_almoco", "saida"],
      ponto_tipo: ["2_batidas", "4_batidas"],
      rh_permission: [
        "manage_employees",
        "approve_documents",
        "configure_schedules",
        "close_payroll",
      ],
      schedule_type: ["fixed_weekly", "rotative"],
    },
  },
} as const
