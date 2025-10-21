import PageClient from "./page-client";

export const metadata = {
  title: "Auth Settings",
};

export const generateStaticParams = async () => {
  return [];
};


export default function Page() {
  return (
    <PageClient />
  );
}
