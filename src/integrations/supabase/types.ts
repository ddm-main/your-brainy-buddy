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
      app_settings: {
        Row: {
          id: string
          key: string
          updated_at: string
          value_json: Json
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string
          value_json?: Json
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string
          value_json?: Json
        }
        Relationships: []
      }
      assets: {
        Row: {
          asset_type: string | null
          created_at: string
          id: string
          metadata: Json
          name: string
          owner: string | null
          updated_at: string
        }
        Insert: {
          asset_type?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          name: string
          owner?: string | null
          updated_at?: string
        }
        Update: {
          asset_type?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          name?: string
          owner?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      attachments: {
        Row: {
          created_at: string
          extracted_text: string | null
          file_name: string
          id: string
          linked_id: string | null
          linked_type: string | null
          mime_type: string | null
          parse_status: Database["public"]["Enums"]["parse_status"]
          storage_path: string | null
        }
        Insert: {
          created_at?: string
          extracted_text?: string | null
          file_name: string
          id?: string
          linked_id?: string | null
          linked_type?: string | null
          mime_type?: string | null
          parse_status?: Database["public"]["Enums"]["parse_status"]
          storage_path?: string | null
        }
        Update: {
          created_at?: string
          extracted_text?: string | null
          file_name?: string
          id?: string
          linked_id?: string | null
          linked_type?: string | null
          mime_type?: string | null
          parse_status?: Database["public"]["Enums"]["parse_status"]
          storage_path?: string | null
        }
        Relationships: []
      }
      automation_runs: {
        Row: {
          automation_id: string
          finished_at: string | null
          id: string
          result: Json | null
          started_at: string
          status: Database["public"]["Enums"]["jarvis_action_status"]
        }
        Insert: {
          automation_id: string
          finished_at?: string | null
          id?: string
          result?: Json | null
          started_at?: string
          status?: Database["public"]["Enums"]["jarvis_action_status"]
        }
        Update: {
          automation_id?: string
          finished_at?: string | null
          id?: string
          result?: Json | null
          started_at?: string
          status?: Database["public"]["Enums"]["jarvis_action_status"]
        }
        Relationships: [
          {
            foreignKeyName: "automation_runs_automation_id_fkey"
            columns: ["automation_id"]
            isOneToOne: false
            referencedRelation: "automations"
            referencedColumns: ["id"]
          },
        ]
      }
      automations: {
        Row: {
          automation_type: Database["public"]["Enums"]["automation_type"]
          config: Json
          created_at: string
          id: string
          is_active: boolean
          last_run_at: string | null
          name: string
          next_run_at: string | null
          updated_at: string
        }
        Insert: {
          automation_type: Database["public"]["Enums"]["automation_type"]
          config?: Json
          created_at?: string
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          name: string
          next_run_at?: string | null
          updated_at?: string
        }
        Update: {
          automation_type?: Database["public"]["Enums"]["automation_type"]
          config?: Json
          created_at?: string
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          name?: string
          next_run_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      banks: {
        Row: {
          created_at: string
          id: string
          name: string
          notes: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          notes?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
        }
        Relationships: []
      }
      category_rules: {
        Row: {
          category: string
          created_at: string
          id: string
          learned_from_correction: boolean
          pattern: string
          priority: number
        }
        Insert: {
          category: string
          created_at?: string
          id?: string
          learned_from_correction?: boolean
          pattern: string
          priority?: number
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          learned_from_correction?: boolean
          pattern?: string
          priority?: number
        }
        Relationships: []
      }
      credit_cards: {
        Row: {
          autopay: boolean
          bank_id: string | null
          billing_day: number | null
          card_name: string
          created_at: string
          due_day: number | null
          id: string
          limit_amount: number | null
          masked_number: string | null
          notes: string | null
          statement_password_rule: Json | null
          updated_at: string
        }
        Insert: {
          autopay?: boolean
          bank_id?: string | null
          billing_day?: number | null
          card_name: string
          created_at?: string
          due_day?: number | null
          id?: string
          limit_amount?: number | null
          masked_number?: string | null
          notes?: string | null
          statement_password_rule?: Json | null
          updated_at?: string
        }
        Update: {
          autopay?: boolean
          bank_id?: string | null
          billing_day?: number | null
          card_name?: string
          created_at?: string
          due_day?: number | null
          id?: string
          limit_amount?: number | null
          masked_number?: string | null
          notes?: string | null
          statement_password_rule?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_cards_bank_id_fkey"
            columns: ["bank_id"]
            isOneToOne: false
            referencedRelation: "banks"
            referencedColumns: ["id"]
          },
        ]
      }
      decisions: {
        Row: {
          context: string | null
          created_at: string
          decided_on: string
          decision_text: string
          id: string
          linked_project_id: string | null
          options_considered: string | null
          rationale: string | null
          title: string
        }
        Insert: {
          context?: string | null
          created_at?: string
          decided_on?: string
          decision_text: string
          id?: string
          linked_project_id?: string | null
          options_considered?: string | null
          rationale?: string | null
          title: string
        }
        Update: {
          context?: string | null
          created_at?: string
          decided_on?: string
          decision_text?: string
          id?: string
          linked_project_id?: string | null
          options_considered?: string | null
          rationale?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "decisions_linked_project_id_fkey"
            columns: ["linked_project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      email_accounts: {
        Row: {
          created_at: string
          email_address: string
          id: string
          is_active: boolean
          provider: string | null
          purpose: Database["public"]["Enums"]["email_purpose"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          email_address: string
          id?: string
          is_active?: boolean
          provider?: string | null
          purpose?: Database["public"]["Enums"]["email_purpose"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          email_address?: string
          id?: string
          is_active?: boolean
          provider?: string | null
          purpose?: Database["public"]["Enums"]["email_purpose"]
          updated_at?: string
        }
        Relationships: []
      }
      email_actions: {
        Row: {
          action: string
          actor: string
          created_at: string
          email_id: string
          id: string
          meta: Json
        }
        Insert: {
          action: string
          actor?: string
          created_at?: string
          email_id: string
          id?: string
          meta?: Json
        }
        Update: {
          action?: string
          actor?: string
          created_at?: string
          email_id?: string
          id?: string
          meta?: Json
        }
        Relationships: [
          {
            foreignKeyName: "email_actions_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
        ]
      }
      email_attachments: {
        Row: {
          attachment_type: string | null
          created_at: string
          email_id: string
          extracted_text: string | null
          file_name: string | null
          id: string
          mime_type: string | null
          parse_status: Database["public"]["Enums"]["parse_status"]
          storage_path: string | null
        }
        Insert: {
          attachment_type?: string | null
          created_at?: string
          email_id: string
          extracted_text?: string | null
          file_name?: string | null
          id?: string
          mime_type?: string | null
          parse_status?: Database["public"]["Enums"]["parse_status"]
          storage_path?: string | null
        }
        Update: {
          attachment_type?: string | null
          created_at?: string
          email_id?: string
          extracted_text?: string | null
          file_name?: string | null
          id?: string
          mime_type?: string | null
          parse_status?: Database["public"]["Enums"]["parse_status"]
          storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_attachments_email_id_fkey"
            columns: ["email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
        ]
      }
      emails: {
        Row: {
          account_id: string | null
          ai_summary: string | null
          body_html: string | null
          body_text: string | null
          category: Database["public"]["Enums"]["email_category"] | null
          cc_json: Json | null
          created_at: string
          external_email_id: string | null
          finance_related: boolean
          from_email: string | null
          from_name: string | null
          id: string
          importance: number | null
          linked_bank_id: string | null
          linked_card_id: string | null
          linked_project_id: string | null
          received_at: string | null
          requires_action: boolean
          subject: string | null
          thread_id: string | null
          to_json: Json | null
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          ai_summary?: string | null
          body_html?: string | null
          body_text?: string | null
          category?: Database["public"]["Enums"]["email_category"] | null
          cc_json?: Json | null
          created_at?: string
          external_email_id?: string | null
          finance_related?: boolean
          from_email?: string | null
          from_name?: string | null
          id?: string
          importance?: number | null
          linked_bank_id?: string | null
          linked_card_id?: string | null
          linked_project_id?: string | null
          received_at?: string | null
          requires_action?: boolean
          subject?: string | null
          thread_id?: string | null
          to_json?: Json | null
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          ai_summary?: string | null
          body_html?: string | null
          body_text?: string | null
          category?: Database["public"]["Enums"]["email_category"] | null
          cc_json?: Json | null
          created_at?: string
          external_email_id?: string | null
          finance_related?: boolean
          from_email?: string | null
          from_name?: string | null
          id?: string
          importance?: number | null
          linked_bank_id?: string | null
          linked_card_id?: string | null
          linked_project_id?: string | null
          received_at?: string | null
          requires_action?: boolean
          subject?: string | null
          thread_id?: string | null
          to_json?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "emails_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "email_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emails_linked_bank_id_fkey"
            columns: ["linked_bank_id"]
            isOneToOne: false
            referencedRelation: "banks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emails_linked_card_id_fkey"
            columns: ["linked_card_id"]
            isOneToOne: false
            referencedRelation: "credit_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emails_linked_project_id_fkey"
            columns: ["linked_project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      entities: {
        Row: {
          created_at: string
          id: string
          metadata: Json
          name: string
          type: Database["public"]["Enums"]["entity_type"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json
          name: string
          type: Database["public"]["Enums"]["entity_type"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json
          name?: string
          type?: Database["public"]["Enums"]["entity_type"]
          updated_at?: string
        }
        Relationships: []
      }
      entity_links: {
        Row: {
          created_at: string
          entity_id: string
          id: string
          target_id: string
          target_type: string
        }
        Insert: {
          created_at?: string
          entity_id: string
          id?: string
          target_id: string
          target_type: string
        }
        Update: {
          created_at?: string
          entity_id?: string
          id?: string
          target_id?: string
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "entity_links_entity_id_fkey"
            columns: ["entity_id"]
            isOneToOne: false
            referencedRelation: "entities"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_email_rules: {
        Row: {
          attachment_name_pattern: string | null
          bank_id: string | null
          created_at: string
          credit_card_id: string | null
          email_account_id: string | null
          id: string
          is_active: boolean
          loan_id: string | null
          sender_pattern: string | null
          statement_password_rule: Json | null
          subject_pattern: string | null
          updated_at: string
        }
        Insert: {
          attachment_name_pattern?: string | null
          bank_id?: string | null
          created_at?: string
          credit_card_id?: string | null
          email_account_id?: string | null
          id?: string
          is_active?: boolean
          loan_id?: string | null
          sender_pattern?: string | null
          statement_password_rule?: Json | null
          subject_pattern?: string | null
          updated_at?: string
        }
        Update: {
          attachment_name_pattern?: string | null
          bank_id?: string | null
          created_at?: string
          credit_card_id?: string | null
          email_account_id?: string | null
          id?: string
          is_active?: boolean
          loan_id?: string | null
          sender_pattern?: string | null
          statement_password_rule?: Json | null
          subject_pattern?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_email_rules_bank_id_fkey"
            columns: ["bank_id"]
            isOneToOne: false
            referencedRelation: "banks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_email_rules_credit_card_id_fkey"
            columns: ["credit_card_id"]
            isOneToOne: false
            referencedRelation: "credit_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_email_rules_email_account_id_fkey"
            columns: ["email_account_id"]
            isOneToOne: false
            referencedRelation: "email_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_email_rules_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_accounts: {
        Row: {
          account_type: string | null
          bank_id: string | null
          created_at: string
          id: string
          masked_number: string | null
          nickname: string
          notes: string | null
          source_email: string | null
          statement_cycle_day: number | null
          updated_at: string
        }
        Insert: {
          account_type?: string | null
          bank_id?: string | null
          created_at?: string
          id?: string
          masked_number?: string | null
          nickname: string
          notes?: string | null
          source_email?: string | null
          statement_cycle_day?: number | null
          updated_at?: string
        }
        Update: {
          account_type?: string | null
          bank_id?: string | null
          created_at?: string
          id?: string
          masked_number?: string | null
          nickname?: string
          notes?: string | null
          source_email?: string | null
          statement_cycle_day?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "financial_accounts_bank_id_fkey"
            columns: ["bank_id"]
            isOneToOne: false
            referencedRelation: "banks"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_goals: {
        Row: {
          created_at: string
          current_amount: number
          goal_type: string | null
          id: string
          linked_account_id: string | null
          notes: string | null
          target_amount: number | null
          target_date: string | null
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_amount?: number
          goal_type?: string | null
          id?: string
          linked_account_id?: string | null
          notes?: string | null
          target_amount?: number | null
          target_date?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_amount?: number
          goal_type?: string | null
          id?: string
          linked_account_id?: string | null
          notes?: string | null
          target_amount?: number | null
          target_date?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "financial_goals_linked_account_id_fkey"
            columns: ["linked_account_id"]
            isOneToOne: false
            referencedRelation: "financial_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      incidents: {
        Row: {
          created_at: string
          description: string | null
          follow_up_date: string | null
          id: string
          issue_type: string | null
          owner_name: string | null
          severity: string | null
          status: string
          title: string
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          follow_up_date?: string | null
          id?: string
          issue_type?: string | null
          owner_name?: string | null
          severity?: string | null
          status?: string
          title: string
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          follow_up_date?: string | null
          id?: string
          issue_type?: string | null
          owner_name?: string | null
          severity?: string | null
          status?: string
          title?: string
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "incidents_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      jarvis_actions: {
        Row: {
          action_type: string
          command_text: string | null
          created_at: string
          id: string
          input: Json | null
          output: Json | null
          status: Database["public"]["Enums"]["jarvis_action_status"]
          target_module: string | null
        }
        Insert: {
          action_type: string
          command_text?: string | null
          created_at?: string
          id?: string
          input?: Json | null
          output?: Json | null
          status?: Database["public"]["Enums"]["jarvis_action_status"]
          target_module?: string | null
        }
        Update: {
          action_type?: string
          command_text?: string | null
          created_at?: string
          id?: string
          input?: Json | null
          output?: Json | null
          status?: Database["public"]["Enums"]["jarvis_action_status"]
          target_module?: string | null
        }
        Relationships: []
      }
      jarvis_reminders: {
        Row: {
          created_at: string
          fire_at: string
          fired: boolean
          id: string
          linked_task_id: string | null
          text: string
        }
        Insert: {
          created_at?: string
          fire_at: string
          fired?: boolean
          id?: string
          linked_task_id?: string | null
          text: string
        }
        Update: {
          created_at?: string
          fire_at?: string
          fired?: boolean
          id?: string
          linked_task_id?: string | null
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "jarvis_reminders_linked_task_id_fkey"
            columns: ["linked_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      loans: {
        Row: {
          created_at: string
          emi_amount: number | null
          id: string
          interest_rate: number | null
          lender_name: string
          linked_account_id: string | null
          loan_type: string | null
          next_due_date: string | null
          notes: string | null
          outstanding_amount: number | null
          principal_amount: number | null
          start_date: string | null
          tenure_months: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          emi_amount?: number | null
          id?: string
          interest_rate?: number | null
          lender_name: string
          linked_account_id?: string | null
          loan_type?: string | null
          next_due_date?: string | null
          notes?: string | null
          outstanding_amount?: number | null
          principal_amount?: number | null
          start_date?: string | null
          tenure_months?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          emi_amount?: number | null
          id?: string
          interest_rate?: number | null
          lender_name?: string
          linked_account_id?: string | null
          loan_type?: string | null
          next_due_date?: string | null
          notes?: string | null
          outstanding_amount?: number | null
          principal_amount?: number | null
          start_date?: string | null
          tenure_months?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "loans_linked_account_id_fkey"
            columns: ["linked_account_id"]
            isOneToOne: false
            referencedRelation: "financial_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
        Row: {
          content: string | null
          created_at: string
          id: string
          linked_entity_id: string | null
          linked_entity_type: string | null
          linked_project_id: string | null
          note_type: Database["public"]["Enums"]["note_type"]
          summary: string | null
          title: string
          updated_at: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          id?: string
          linked_entity_id?: string | null
          linked_entity_type?: string | null
          linked_project_id?: string | null
          note_type?: Database["public"]["Enums"]["note_type"]
          summary?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          content?: string | null
          created_at?: string
          id?: string
          linked_entity_id?: string | null
          linked_entity_type?: string | null
          linked_project_id?: string | null
          note_type?: Database["public"]["Enums"]["note_type"]
          summary?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notes_linked_project_id_fkey"
            columns: ["linked_project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      procurement_items: {
        Row: {
          amount: number | null
          created_at: string
          expected_on: string | null
          id: string
          item: string
          notes: string | null
          requested_on: string | null
          status: string
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          amount?: number | null
          created_at?: string
          expected_on?: string | null
          id?: string
          item: string
          notes?: string | null
          requested_on?: string | null
          status?: string
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          amount?: number | null
          created_at?: string
          expected_on?: string | null
          id?: string
          item?: string
          notes?: string | null
          requested_on?: string | null
          status?: string
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "procurement_items_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          currency: string | null
          full_name: string | null
          id: string
          prefs: Json
          timezone: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string | null
          full_name?: string | null
          id?: string
          prefs?: Json
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string | null
          full_name?: string | null
          id?: string
          prefs?: Json
          timezone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      project_updates: {
        Row: {
          created_at: string
          id: string
          project_id: string
          update_text: string
          update_type: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          project_id: string
          update_text: string
          update_type?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          project_id?: string
          update_text?: string
          update_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "project_updates_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          blocker_summary: string | null
          created_at: string
          description: string | null
          due_date: string | null
          id: string
          name: string
          next_action: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          slug: string | null
          start_date: string | null
          status: Database["public"]["Enums"]["project_status"]
          updated_at: string
        }
        Insert: {
          blocker_summary?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          name: string
          next_action?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          slug?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          updated_at?: string
        }
        Update: {
          blocker_summary?: string | null
          created_at?: string
          description?: string | null
          due_date?: string | null
          id?: string
          name?: string
          next_action?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          slug?: string | null
          start_date?: string | null
          status?: Database["public"]["Enums"]["project_status"]
          updated_at?: string
        }
        Relationships: []
      }
      reconciliation_matches: {
        Row: {
          confidence_score: number | null
          created_at: string
          id: string
          matched_transaction_id: string | null
          notes: string | null
          statement_id: string
          statement_transaction_hash: string | null
          status: Database["public"]["Enums"]["reconciliation_status"]
        }
        Insert: {
          confidence_score?: number | null
          created_at?: string
          id?: string
          matched_transaction_id?: string | null
          notes?: string | null
          statement_id: string
          statement_transaction_hash?: string | null
          status?: Database["public"]["Enums"]["reconciliation_status"]
        }
        Update: {
          confidence_score?: number | null
          created_at?: string
          id?: string
          matched_transaction_id?: string | null
          notes?: string | null
          statement_id?: string
          statement_transaction_hash?: string | null
          status?: Database["public"]["Enums"]["reconciliation_status"]
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_matches_matched_transaction_id_fkey"
            columns: ["matched_transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_matches_statement_id_fkey"
            columns: ["statement_id"]
            isOneToOne: false
            referencedRelation: "statements"
            referencedColumns: ["id"]
          },
        ]
      }
      renewals: {
        Row: {
          amount: number | null
          category: string | null
          created_at: string
          id: string
          linked_project_id: string | null
          linked_vendor_id: string | null
          name: string
          notes: string | null
          renewal_date: string | null
          updated_at: string
        }
        Insert: {
          amount?: number | null
          category?: string | null
          created_at?: string
          id?: string
          linked_project_id?: string | null
          linked_vendor_id?: string | null
          name: string
          notes?: string | null
          renewal_date?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number | null
          category?: string | null
          created_at?: string
          id?: string
          linked_project_id?: string | null
          linked_vendor_id?: string | null
          name?: string
          notes?: string | null
          renewal_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "renewals_linked_project_id_fkey"
            columns: ["linked_project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "renewals_linked_vendor_id_fkey"
            columns: ["linked_vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      statements: {
        Row: {
          bank_id: string | null
          created_at: string
          credit_card_id: string | null
          file_path: string | null
          financial_account_id: string | null
          id: string
          loan_id: string | null
          notes: string | null
          parse_status: Database["public"]["Enums"]["parse_status"]
          reconciliation_status: Database["public"]["Enums"]["reconciliation_status"]
          source_email_id: string | null
          statement_date: string | null
          statement_end_date: string | null
          statement_start_date: string | null
          statement_type: Database["public"]["Enums"]["statement_type"]
          transactions_found: number
          updated_at: string
        }
        Insert: {
          bank_id?: string | null
          created_at?: string
          credit_card_id?: string | null
          file_path?: string | null
          financial_account_id?: string | null
          id?: string
          loan_id?: string | null
          notes?: string | null
          parse_status?: Database["public"]["Enums"]["parse_status"]
          reconciliation_status?: Database["public"]["Enums"]["reconciliation_status"]
          source_email_id?: string | null
          statement_date?: string | null
          statement_end_date?: string | null
          statement_start_date?: string | null
          statement_type: Database["public"]["Enums"]["statement_type"]
          transactions_found?: number
          updated_at?: string
        }
        Update: {
          bank_id?: string | null
          created_at?: string
          credit_card_id?: string | null
          file_path?: string | null
          financial_account_id?: string | null
          id?: string
          loan_id?: string | null
          notes?: string | null
          parse_status?: Database["public"]["Enums"]["parse_status"]
          reconciliation_status?: Database["public"]["Enums"]["reconciliation_status"]
          source_email_id?: string | null
          statement_date?: string | null
          statement_end_date?: string | null
          statement_start_date?: string | null
          statement_type?: Database["public"]["Enums"]["statement_type"]
          transactions_found?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "statements_bank_id_fkey"
            columns: ["bank_id"]
            isOneToOne: false
            referencedRelation: "banks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statements_credit_card_id_fkey"
            columns: ["credit_card_id"]
            isOneToOne: false
            referencedRelation: "credit_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statements_financial_account_id_fkey"
            columns: ["financial_account_id"]
            isOneToOne: false
            referencedRelation: "financial_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statements_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statements_source_email_id_fkey"
            columns: ["source_email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          amount: number | null
          billing_cycle: string | null
          category: string | null
          created_at: string
          id: string
          linked_account_id: string | null
          linked_card_id: string | null
          name: string
          next_due_date: string | null
          notes: string | null
          updated_at: string
        }
        Insert: {
          amount?: number | null
          billing_cycle?: string | null
          category?: string | null
          created_at?: string
          id?: string
          linked_account_id?: string | null
          linked_card_id?: string | null
          name: string
          next_due_date?: string | null
          notes?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number | null
          billing_cycle?: string | null
          category?: string | null
          created_at?: string
          id?: string
          linked_account_id?: string | null
          linked_card_id?: string | null
          name?: string
          next_due_date?: string | null
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_linked_account_id_fkey"
            columns: ["linked_account_id"]
            isOneToOne: false
            referencedRelation: "financial_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_linked_card_id_fkey"
            columns: ["linked_card_id"]
            isOneToOne: false
            referencedRelation: "credit_cards"
            referencedColumns: ["id"]
          },
        ]
      }
      tags: {
        Row: {
          color: string | null
          created_at: string
          id: string
          kind: string | null
          name: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          kind?: string | null
          name: string
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          kind?: string | null
          name?: string
        }
        Relationships: []
      }
      task_activity: {
        Row: {
          action: string
          created_at: string
          id: string
          meta: Json
          task_id: string
        }
        Insert: {
          action: string
          created_at?: string
          id?: string
          meta?: Json
          task_id: string
        }
        Update: {
          action?: string
          created_at?: string
          id?: string
          meta?: Json
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_activity_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      task_recurrence_rules: {
        Row: {
          config: Json
          created_at: string
          id: string
          recurrence_type: string
          task_id: string
        }
        Insert: {
          config?: Json
          created_at?: string
          id?: string
          recurrence_type: string
          task_id: string
        }
        Update: {
          config?: Json
          created_at?: string
          id?: string
          recurrence_type?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_recurrence_rules_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          category: string | null
          created_at: string
          description: string | null
          due_at: string | null
          focus: boolean
          id: string
          linked_account_id: string | null
          linked_email_id: string | null
          linked_goal_id: string | null
          linked_project_id: string | null
          owner: string | null
          priority: Database["public"]["Enums"]["task_priority"]
          reminder_at: string | null
          source: string | null
          status: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          description?: string | null
          due_at?: string | null
          focus?: boolean
          id?: string
          linked_account_id?: string | null
          linked_email_id?: string | null
          linked_goal_id?: string | null
          linked_project_id?: string | null
          owner?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          reminder_at?: string | null
          source?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          description?: string | null
          due_at?: string | null
          focus?: boolean
          id?: string
          linked_account_id?: string | null
          linked_email_id?: string | null
          linked_goal_id?: string | null
          linked_project_id?: string | null
          owner?: string | null
          priority?: Database["public"]["Enums"]["task_priority"]
          reminder_at?: string | null
          source?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_linked_account_id_fkey"
            columns: ["linked_account_id"]
            isOneToOne: false
            referencedRelation: "financial_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_linked_email_id_fkey"
            columns: ["linked_email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_linked_goal_id_fkey"
            columns: ["linked_goal_id"]
            isOneToOne: false
            referencedRelation: "financial_goals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_linked_project_id_fkey"
            columns: ["linked_project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      transactions: {
        Row: {
          amount: number
          category: string | null
          confidence_score: number | null
          created_at: string
          credit_card_id: string | null
          description: string | null
          duplicate_group_id: string | null
          financial_account_id: string | null
          id: string
          is_reconciled: boolean
          loan_id: string | null
          merchant: string | null
          notes: string | null
          reference_number: string | null
          source: Database["public"]["Enums"]["txn_source"]
          source_email_id: string | null
          source_statement_id: string | null
          txn_date: string
          txn_type: Database["public"]["Enums"]["txn_type"]
          updated_at: string
        }
        Insert: {
          amount: number
          category?: string | null
          confidence_score?: number | null
          created_at?: string
          credit_card_id?: string | null
          description?: string | null
          duplicate_group_id?: string | null
          financial_account_id?: string | null
          id?: string
          is_reconciled?: boolean
          loan_id?: string | null
          merchant?: string | null
          notes?: string | null
          reference_number?: string | null
          source?: Database["public"]["Enums"]["txn_source"]
          source_email_id?: string | null
          source_statement_id?: string | null
          txn_date: string
          txn_type: Database["public"]["Enums"]["txn_type"]
          updated_at?: string
        }
        Update: {
          amount?: number
          category?: string | null
          confidence_score?: number | null
          created_at?: string
          credit_card_id?: string | null
          description?: string | null
          duplicate_group_id?: string | null
          financial_account_id?: string | null
          id?: string
          is_reconciled?: boolean
          loan_id?: string | null
          merchant?: string | null
          notes?: string | null
          reference_number?: string | null
          source?: Database["public"]["Enums"]["txn_source"]
          source_email_id?: string | null
          source_statement_id?: string | null
          txn_date?: string
          txn_type?: Database["public"]["Enums"]["txn_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_credit_card_id_fkey"
            columns: ["credit_card_id"]
            isOneToOne: false
            referencedRelation: "credit_cards"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_financial_account_id_fkey"
            columns: ["financial_account_id"]
            isOneToOne: false
            referencedRelation: "financial_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_source_email_id_fkey"
            columns: ["source_email_id"]
            isOneToOne: false
            referencedRelation: "emails"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_source_statement_id_fkey"
            columns: ["source_statement_id"]
            isOneToOne: false
            referencedRelation: "statements"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          id: string
          name: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      automation_type:
        | "finance_scan"
        | "inbox_scan"
        | "daily_brief"
        | "weekly_review"
        | "custom"
      email_category:
        | "important"
        | "needs_reply"
        | "follow_up"
        | "finance"
        | "work"
        | "personal"
        | "other"
      email_purpose: "work" | "finance" | "personal" | "other"
      entity_type:
        | "person"
        | "vendor"
        | "bank"
        | "project"
        | "tool"
        | "place"
        | "other"
      jarvis_action_status:
        | "pending"
        | "running"
        | "success"
        | "error"
        | "cancelled"
      note_type:
        | "general"
        | "project"
        | "meeting"
        | "sop"
        | "decision"
        | "reference"
        | "personal"
        | "finance"
      parse_status: "pending" | "ok" | "failed" | "skipped"
      project_status: "active" | "blocked" | "done" | "archived" | "paused"
      reconciliation_status:
        | "pending"
        | "matched"
        | "partial"
        | "conflict"
        | "reviewed"
      statement_type: "bank" | "credit_card" | "loan"
      task_priority: "low" | "normal" | "high" | "urgent"
      task_status: "todo" | "doing" | "waiting" | "done" | "cancelled"
      txn_source: "manual" | "email" | "statement" | "import" | "api"
      txn_type: "debit" | "credit"
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
      automation_type: [
        "finance_scan",
        "inbox_scan",
        "daily_brief",
        "weekly_review",
        "custom",
      ],
      email_category: [
        "important",
        "needs_reply",
        "follow_up",
        "finance",
        "work",
        "personal",
        "other",
      ],
      email_purpose: ["work", "finance", "personal", "other"],
      entity_type: [
        "person",
        "vendor",
        "bank",
        "project",
        "tool",
        "place",
        "other",
      ],
      jarvis_action_status: [
        "pending",
        "running",
        "success",
        "error",
        "cancelled",
      ],
      note_type: [
        "general",
        "project",
        "meeting",
        "sop",
        "decision",
        "reference",
        "personal",
        "finance",
      ],
      parse_status: ["pending", "ok", "failed", "skipped"],
      project_status: ["active", "blocked", "done", "archived", "paused"],
      reconciliation_status: [
        "pending",
        "matched",
        "partial",
        "conflict",
        "reviewed",
      ],
      statement_type: ["bank", "credit_card", "loan"],
      task_priority: ["low", "normal", "high", "urgent"],
      task_status: ["todo", "doing", "waiting", "done", "cancelled"],
      txn_source: ["manual", "email", "statement", "import", "api"],
      txn_type: ["debit", "credit"],
    },
  },
} as const
