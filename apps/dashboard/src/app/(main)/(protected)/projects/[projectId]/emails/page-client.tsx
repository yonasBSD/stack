"use client";

import { TeamMemberSearchTable } from "@/components/data-table/team-member-search-table";
import { FormDialog } from "@/components/form-dialog";
import { InputField, SelectField, TextAreaField } from "@/components/form-fields";
import { SettingCard, SettingText } from "@/components/settings";
import { getPublicEnvVar } from "@/lib/env";
import { AdminEmailConfig, AdminProject, AdminSentEmail, ServerUser, UserAvatar } from "@stackframe/stack";
import { strictEmailSchema } from "@stackframe/stack-shared/dist/schema-fields";
import { throwErr } from "@stackframe/stack-shared/dist/utils/errors";
import { deepPlainEquals } from "@stackframe/stack-shared/dist/utils/objects";
import { runAsynchronously } from "@stackframe/stack-shared/dist/utils/promises";
import { ActionDialog, Alert, Button, DataTable, SimpleTooltip, Typography, useToast, TooltipProvider, TooltipTrigger, TooltipContent, Tooltip, AlertDescription, AlertTitle } from "@stackframe/stack-ui";
import { ColumnDef } from "@tanstack/react-table";
import { AlertCircle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as yup from "yup";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";
import { CompleteConfig } from "@stackframe/stack-shared/dist/config/schema";

export default function PageClient() {
  const stackAdminApp = useAdminApp();
  const project = stackAdminApp.useProject();
  const emailConfig = project.useConfig().emails.server;

  return (
    <PageLayout
      title="Emails"
      description="Manage email server and logs"
      actions={
        <SendEmailDialog
          trigger={<Button>Send Email</Button>}
          emailConfig={emailConfig}
        />
      }
    >
      {getPublicEnvVar('NEXT_PUBLIC_STACK_EMULATOR_ENABLED') === 'true' ? (
        <SettingCard
          title="Mock Emails"
          description="View all emails sent through the emulator in Inbucket"
        >
          <Button variant='secondary' onClick={() => {
            window.open(getPublicEnvVar('NEXT_PUBLIC_STACK_INBUCKET_WEB_URL') + '/monitor', '_blank');
          }}>
            Open Inbox
          </Button>
        </SettingCard>
      ) : (
        <SettingCard
          title="Email Server"
          description="Configure the email server and sender address for outgoing emails"
          actions={
            <div className="flex items-center gap-2">
              {!emailConfig.isShared && <TestSendingDialog trigger={<Button variant='secondary' className="w-full">Send Test Email</Button>} />}
              <EditEmailServerDialog trigger={<Button variant='secondary' className="w-full">Configure</Button>} />
            </div>
          }
        >
          <SettingText label="Server">
            <div className="flex items-center gap-2">
              {emailConfig.isShared ?
                <>Shared <SimpleTooltip tooltip="When you use the shared email server, all the emails are sent from Stack's email address" type='info' /></>
                : (emailConfig.provider === 'resend' ? "Resend" : "Custom SMTP server")
              }
            </div>
          </SettingText>
          <SettingText label="Sender Email">
            {emailConfig.isShared ? 'noreply@stackframe.co' : emailConfig.senderEmail}
          </SettingText>
        </SettingCard>
      )}
      <SettingCard title="Email Log" description="Manage email sending history" >
        <EmailSendDataTable />
      </SettingCard>
    </PageLayout>
  );
}

function definedWhenTypeIsOneOf<S extends yup.AnyObject>(schema: S, types: string[], message: string): S {
  return schema.when('type', {
    is: (t: string) => types.includes(t),
    then: (schema: S) => schema.defined(message),
    otherwise: (schema: S) => schema.optional()
  });
}

const getDefaultValues = (emailConfig: CompleteConfig['emails']['server'] | undefined, project: AdminProject) => {
  if (!emailConfig) {
    return { type: 'shared', senderName: project.displayName } as const;
  } else if (emailConfig.isShared) {
    return { type: 'shared' } as const;
  } else if (emailConfig.provider === 'resend') {
    return {
      type: 'resend',
      senderEmail: emailConfig.senderEmail,
      senderName: emailConfig.senderName,
      password: emailConfig.password,
    } as const;
  } else {
    return {
      type: 'standard',
      senderName: emailConfig.senderName,
      host: emailConfig.host,
      port: emailConfig.port,
      username: emailConfig.username,
      password: emailConfig.password,
      senderEmail: emailConfig.senderEmail,
    } as const;
  }
};

const emailServerSchema = yup.object({
  type: yup.string().oneOf(['shared', 'standard', 'resend']).defined(),
  host: definedWhenTypeIsOneOf(yup.string(), ["standard"], "Host is required"),
  port: definedWhenTypeIsOneOf(yup.number().min(0, "Port must be a number between 0 and 65535").max(65535, "Port must be a number between 0 and 65535"), ["standard"], "Port is required"),
  username: definedWhenTypeIsOneOf(yup.string(), ["standard"], "Username is required"),
  password: definedWhenTypeIsOneOf(yup.string(), ["standard", "resend"], "Password is required"),
  senderEmail: definedWhenTypeIsOneOf(strictEmailSchema("Sender email must be a valid email"), ["standard", "resend"], "Sender email is required"),
  senderName: definedWhenTypeIsOneOf(yup.string(), ["standard", "resend"], "Email sender name is required"),
});

function EditEmailServerDialog(props: {
  trigger: React.ReactNode,
}) {
  const stackAdminApp = useAdminApp();
  const project = stackAdminApp.useProject();
  const config = project.useConfig();
  const [error, setError] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<any>(null);
  const defaultValues = useMemo(() => getDefaultValues(config.emails.server, project), [config, project]);
  const { toast } = useToast();

  async function testEmailAndUpdateConfig(emailConfig: AdminEmailConfig & { type: "standard" | "resend" }) {
    const testResult = await stackAdminApp.sendTestEmail({
      recipientEmail: 'test-email-recipient@stackframe.co',
      emailConfig,
    });

    if (testResult.status === 'error') {
      setError(testResult.error.errorMessage);
      return 'prevent-close-and-prevent-reset';
    }
    setError(null);
    await project.updateConfig({
      emails: {
        server: {
          isShared: false,
          host: emailConfig.host,
          port: emailConfig.port,
          username: emailConfig.username,
          password: emailConfig.password,
          senderEmail: emailConfig.senderEmail,
          senderName: emailConfig.senderName,
          provider: emailConfig.type === 'resend' ? 'resend' : 'smtp',
        }
      }
    });

    toast({
      title: "Email server updated",
      description: "The email server has been updated. You can now send test emails to verify the configuration.",
      variant: 'success',
    });
  }

  return <FormDialog
    trigger={props.trigger}
    title="Edit Email Server"
    formSchema={emailServerSchema}
    defaultValues={defaultValues}
    okButton={{ label: "Save" }}
    onSubmit={async (values) => {
      if (values.type === 'shared') {
        await project.update({
          config: {
            emailConfig: { type: 'shared' }
          }
        });
      } else if (values.type === 'resend') {
        if (!values.password || !values.senderEmail || !values.senderName) {
          throwErr("Missing email server config for Resend");
        }
        return await testEmailAndUpdateConfig({
          type: 'resend',
          host: 'smtp.resend.com',
          port: 465,
          username: 'resend',
          password: values.password,
          senderEmail: values.senderEmail,
          senderName: values.senderName,
        });
      } else {
        if (!values.host || !values.port || !values.username || !values.password || !values.senderEmail || !values.senderName) {
          throwErr("Missing email server config for custom SMTP server");
        }
        return await testEmailAndUpdateConfig({
          type: 'standard',
          host: values.host,
          port: values.port,
          username: values.username,
          password: values.password,
          senderEmail: values.senderEmail,
          senderName: values.senderName
        });
      }
    }}
    cancelButton
    onFormChange={(form) => {
      const values = form.getValues();
      if (!deepPlainEquals(values, formValues)) {
        setFormValues(values);
        setError(null);
      }
    }}
    render={(form) => (
      <>
        <SelectField
          label="Email server"
          name="type"
          control={form.control}
          options={[
            { label: "Shared (noreply@stackframe.co)", value: 'shared' },
            { label: "Resend (your own email address)", value: 'resend' },
            { label: "Custom SMTP server (your own email address)", value: 'standard' },
          ]}
        />
        {form.watch('type') === 'resend' && <>
          {([
            { label: "Resend API Key", name: "password", type: 'password' },
            { label: "Sender Email", name: "senderEmail", type: 'email' },
            { label: "Sender Name", name: "senderName", type: 'text' },
          ] as const).map((field) => (
            <InputField
              key={field.name}
              label={field.label}
              name={field.name}
              control={form.control}
              type={field.type}
              required
            />
          ))}
        </>}
        {form.watch('type') === 'standard' && <>
          {([
            { label: "Host", name: "host", type: 'text' },
            { label: "Port", name: "port", type: 'number' },
            { label: "Username", name: "username", type: 'text' },
            { label: "Password", name: "password", type: 'password' },
            { label: "Sender Email", name: "senderEmail", type: 'email' },
            { label: "Sender Name", name: "senderName", type: 'text' },
          ] as const).map((field) => (
            <InputField
              key={field.name}
              label={field.label}
              name={field.name}
              control={form.control}
              type={field.type}
              required
            />
          ))}
        </>}
        {error && <Alert variant="destructive">{error}</Alert>}
      </>
    )}
  />;
}

function TestSendingDialog(props: {
  trigger: React.ReactNode,
}) {
  const stackAdminApp = useAdminApp();
  const project = stackAdminApp.useProject();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);

  return <FormDialog
    trigger={props.trigger}
    title="Send a Test Email"
    formSchema={yup.object({
      email: yup.string().email().defined().label("Recipient email address")
    })}
    okButton={{ label: "Send" }}
    onSubmit={async (values) => {
      const emailConfig = project.config.emailConfig || throwErr("Email config is not set");
      if (emailConfig.type === 'shared') throwErr("Shared email server cannot be used for testing");

      const result = await stackAdminApp.sendTestEmail({
        recipientEmail: values.email,
        emailConfig: emailConfig,
      });

      if (result.status === 'ok') {
        toast({
          title: "Email sent",
          description: `The test email has been sent to ${values.email}. Please check your inbox.`,
          variant: 'success',
        });
      } else {
        setError(result.error.errorMessage);
        return 'prevent-close';
      }
    }}
    cancelButton
    onFormChange={(form) => {
      if (form.getValues('email')) {
        setError(null);
      }
    }}
    render={(form) => (
      <>
        <InputField label="Email" name="email" control={form.control} type="email" autoComplete="email" required />
        {error && <Alert variant="destructive">{error}</Alert>}
      </>
    )}
  />;
}

const emailTableColumns: ColumnDef<AdminSentEmail>[] = [
  { accessorKey: 'recipient', header: 'Recipient' },
  { accessorKey: 'subject', header: 'Subject' },
  {
    accessorKey: 'sentAt', header: 'Sent At', cell: ({ row }) => {
      const date = row.original.sentAt;
      return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
    }
  },
  {
    accessorKey: 'status', header: 'Status', cell: ({ row }) => {
      return row.original.error ? (
        <div className="text-red-500">Failed</div>
      ) : (
        <div className="text-green-500">Sent</div>
      );
    }
  },
];

function EmailSendDataTable() {
  const stackAdminApp = useAdminApp();
  const [emailLogs, setEmailLogs] = useState<AdminSentEmail[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch email logs when component mounts
  useEffect(() => {
    runAsynchronously(async () => {
      setLoading(true);
      try {
        const emails = await stackAdminApp.listSentEmails();
        setEmailLogs(emails);
      } finally {
        setLoading(false);
      }
    });
  }, [stackAdminApp]);

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <Typography>Loading email logs...</Typography>
      </div>
    );
  }

  return <DataTable
    data={emailLogs}
    defaultColumnFilters={[]}
    columns={emailTableColumns}
    defaultSorting={[{ id: 'sentAt', desc: true }]}
  />;
}

function SendEmailDialog(props: {
  trigger: React.ReactNode,
  emailConfig: CompleteConfig['emails']['server'],
}) {
  const stackAdminApp = useAdminApp();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [sharedSmtpDialogOpen, setSharedSmtpDialogOpen] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<ServerUser[]>([]);
  const [stage, setStage] = useState<'recipients' | 'data'>('recipients');

  const handleSend = async (formData: { subject?: string, content?: string, notificationCategoryName?: string }) => {
    if (!formData.subject || !formData.content || !formData.notificationCategoryName) {
      // Should never happen. These fields are only optional during recipient stage.
      throwErr("Missing required fields", { formData });
    }

    await stackAdminApp.sendEmail({
      userIds: selectedUsers.map(user => user.id),
      subject: formData.subject,
      html: formData.content,
      notificationCategoryName: formData.notificationCategoryName,
    });

    setSelectedUsers([]);
    setStage('recipients');
    toast({
      title: "Email sent",
      description: "Email was successfully sent",
      variant: 'success',
    });
  };

  const handleNext = async () => {
    if (selectedUsers.length === 0) {
      toast({
        title: "No recipients selected",
        description: "Please select at least one recipient to send the email.",
        variant: "destructive",
      });
      return "prevent-close" as const;
    }
    setStage('data');
    return "prevent-close" as const;
  };

  const handleBack = async () => {
    setStage('recipients');
    return "prevent-close" as const;
  };

  const handleClose = () => {
    setOpen(false);
    setStage('recipients');
    setSelectedUsers([]);
  };

  const renderRecipientsBar = () => (
    <div className="mb-4">
      <Typography className="font-medium mb-2">Recipients</Typography>
      <TooltipProvider>
        <div className="flex flex-wrap gap-2 mb-4">
          {selectedUsers.map((user) => (
            <div key={user.id} className="relative group">
              <Tooltip>
                <TooltipTrigger>
                  <UserAvatar user={user} size={32} />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="max-w-60 text-center text-wrap whitespace-pre-wrap">
                    {user.primaryEmail}
                  </div>
                </TooltipContent>
              </Tooltip>
              {stage === 'recipients' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="absolute -top-2 -right-2 h-4 w-4 rounded-full p-0 hover:bg-red-100 opacity-0 group-hover:opacity-100"
                  onClick={() => setSelectedUsers(users => users.filter(u => u.id !== user.id))}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </TooltipProvider>
    </div>
  );

  return (
    <>
      <div
        onClick={() => {
          if (!props.emailConfig.isShared) {
            setOpen(true);
          } else {
            setSharedSmtpDialogOpen(true);
          }
        }}
      >
        {props.trigger}
      </div>
      <ActionDialog
        open={sharedSmtpDialogOpen}
        onClose={() => setSharedSmtpDialogOpen(false)}
        title="Shared Email Server"
        okButton
      >
        <Alert variant="default">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Warning</AlertTitle>
          <AlertDescription>
            You are using a shared email server. If you want to send manual emails, you need to configure a custom SMTP server.
          </AlertDescription>
        </Alert>
      </ActionDialog>
      <FormDialog
        open={open}
        onClose={handleClose}
        title="Send Email"
        cancelButton={stage === "recipients" ?
          { label: 'Cancel', onClick: async () => handleClose() } :
          { label: 'Back', onClick: handleBack }
        }
        okButton={stage === 'recipients' ?
          { label: 'Next' } :
          { label: 'Send' }
        }
        onSubmit={stage === 'recipients' ? handleNext : handleSend}
        formSchema={stage === "recipients" ?
          yup.object({
            subject: yup.string().optional(),
            content: yup.string().optional(),
            notificationCategoryName: yup.string().optional(),
          }) :
          yup.object({
            subject: yup.string().defined(),
            content: yup.string().defined(),
            notificationCategoryName: yup.string().oneOf(['Transactional', 'Marketing']).label("notification category").defined(),
          })
        }
        render={(form) => (
          <>
            {renderRecipientsBar()}
            {stage === 'recipients' ? (
              <TeamMemberSearchTable
                action={(user) => (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSelectedUsers(users =>
                      users.some(u => u.id === user.id)
                        ? users.filter(u => u.id !== user.id)
                        : [...users, user]
                    )}
                  >
                    {selectedUsers.some(u => u.id === user.id) ? 'Remove' : 'Add'}
                  </Button>
                )}
              />
            ) : (
              <>
                <InputField label="Subject" name="subject" control={form.control} type="text" required />
                {/* TODO: fetch notification categories here instead of hardcoding these two */}
                <SelectField
                  label="Notification Category"
                  name="notificationCategoryName"
                  control={form.control}
                  options={[
                    { label: "Transactional", value: 'Transactional' },
                    { label: "Marketing", value: 'Marketing' },
                  ]}
                />
                <TextAreaField
                  label="Email Content"
                  name="content"
                  control={form.control}
                  rows={10}
                  required
                />
              </>
            )}
          </>
        )}
      />
    </>
  );
}
