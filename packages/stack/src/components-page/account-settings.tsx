'use client';

import React from 'react';
import { PasswordField, useStackApp, useUser } from '..';
import RedirectMessageCard from '../components/redirect-message-card';
import { Text, Label, Input, Button, Card, CardHeader, CardDescription, CardContent, CardFooter, Container } from "../components-core";
import UserAvatar from '../components/user-avatar';
import { useState } from 'react';
import { runAsynchronously } from '@stackframe/stack-shared/dist/utils/promises';
import FormWarningText from '../components/form-warning';
import { CardTitle } from '../components-core/card';
import { getPasswordError } from '@stackframe/stack-shared/dist/helpers/password';

function SettingSection(props: { 
  title: string, 
  desc: string, 
  buttonText?: string, 
  buttonDisabled?: boolean,
  buttonLoading?: boolean,
  onButtonClick?: () => void,
  buttonVariant?: 'primary' | 'secondary',
  children?: React.ReactNode, 
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{props.desc}</CardDescription>
      </CardHeader>
      {props.children && <CardContent>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {props.children}
        </div>
      </CardContent>}
      {props.buttonText && <CardFooter>
        <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
          <Button 
            disabled={props.buttonDisabled} 
            onClick={props.onButtonClick} 
            loading={props.buttonLoading} 
            variant={props.buttonVariant}
          >
            {props.buttonText}
          </Button>
        </div>
      </CardFooter>}
    </Card>
  );
} 

function ProfileSection() {
  const user = useUser();
  const [userInfo, setUserInfo] = useState<{ displayName: string }>({ displayName: user?.displayName || '' });
  const [changed, setChanged] = useState(false);

  return (
    <SettingSection
      title='Profile'
      desc='Your profile information'
      buttonDisabled={!changed}
      buttonText='Save'
      onButtonClick={() => runAsynchronously(async () => {
        await user?.update(userInfo);
        setChanged(false);
      })}
    >
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <UserAvatar size={60}/>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <Text size='lg'>{user?.displayName}</Text>
          <Text variant='secondary' size='sm'>{user?.primaryEmail}</Text>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <Label htmlFor='display-name'>Display Name</Label>
        <Input
          id='display-name'
          value={userInfo.displayName}
          onChange={(e) => {
            setUserInfo((i) => ({...i, displayName: e.target.value }));
            setChanged(true);
          }}
        />
      </div>
    </SettingSection>
  );
}

function EmailVerificationSection() {
  const user = useUser();
  const [emailSent, setEmailSent] = useState(false);
  const [sedingEmail, setSendingEmail] = useState(false);

  return (
    <SettingSection
      title='Email Verification'
      desc='We want to make sure that you own the email address'
      buttonDisabled={emailSent}
      buttonText={
        !user?.primaryEmailVerified ? 
          emailSent ? 
            'Email Sent' : 
            'Send Email'
          : undefined
      }
      buttonLoading={sedingEmail}
      onButtonClick={() => runAsynchronously(async () => {
        setSendingEmail(true);
        await user?.sendVerificationEmail();
        setEmailSent(true);
        setSendingEmail(false);
      })}
    >
      {user?.primaryEmailVerified ? 
        <Text variant='success'>Your email has been verified</Text> : 
        <Text variant='warning'>Your Email has not been verified</Text>}
    </SettingSection>
  );
}

function PasswordSection() {
  const user = useUser();
  const [oldPassword, setOldPassword] = useState<string>('');
  const [oldPasswordError, setOldPasswordError] = useState<string>('');
  const [newPassword, setNewPassword] = useState<string>('');
  const [newPasswordError, setNewPasswordError] = useState<string>('');
  const [saving, setSaving] = useState(false);

  if (user?.authMethod !== 'credential') {
    return null;
  }

  return (
    <SettingSection
      title='Password'
      desc='Change your password'
      buttonDisabled={!oldPassword || !newPassword}
      buttonText='Save'
      buttonLoading={saving}
      onButtonClick={() => runAsynchronously(async () => {
        if (oldPassword && newPassword) {
          const errorMessage = getPasswordError(newPassword);
          if (errorMessage) {
            setNewPasswordError(errorMessage.message);
          } else {
            const errorCode = await user?.updatePassword({ oldPassword, newPassword });
            if (errorCode) {
              setOldPasswordError('Incorrect password');
            } else {
              setOldPassword('');
              setNewPassword('');
            }
          }
        } else if (oldPassword && !newPassword) {
          setNewPasswordError('Please enter a new password');
        } else if (newPassword && !oldPassword) {
          setOldPasswordError('Please enter your old password');
        }
      })}
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <Label htmlFor='old-password'>Old Password</Label>
        <PasswordField
          id='old-password' 
          value={oldPassword} 
          onChange={(e) => {
            setOldPassword(e.target.value);
            setOldPasswordError('');
          }}
        />
        <FormWarningText text={oldPasswordError} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <Label htmlFor='new-password'>New Password</Label>
        <PasswordField
          id='new-password' 
          value={newPassword} 
          onChange={(e) => {
            setNewPassword(e.target.value);
            setNewPasswordError('');
          }}
        />
        <FormWarningText text={newPasswordError} />
      </div>
    </SettingSection>
  );
}

function SignOutSection() {
  const user = useUser();
  return (
    <SettingSection
      title='Sign out'
      desc='Sign out of your account on this device'
      buttonVariant='secondary'
      buttonText='Sign Out'
      onButtonClick={() => runAsynchronously(user?.signOut)}
    >
    </SettingSection>
  );
}

export default function AccountSettings({ fullPage=false }: { fullPage?: boolean }) {
  const user = useUser();
  if (!user) {
    return <RedirectMessageCard type='signedOut' fullPage={fullPage} />;
  }

  const inner = (
    <div style={{ padding: fullPage ? '1rem' : 0, display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div>
        <Text size="xl" as='h2' style={{ marginBottom: '0.5rem', fontWeight: '700' }}>Account Settings</Text>
        <Text variant='secondary'>Manage your account</Text>
      </div>
      
      <ProfileSection />
      <EmailVerificationSection />
      <PasswordSection />
      <SignOutSection />
    </div>
  );

  if (fullPage) {
    return (
      <Container size='sm'>
        {inner}
      </Container>
    );
  } else {
    return inner;
  }
}