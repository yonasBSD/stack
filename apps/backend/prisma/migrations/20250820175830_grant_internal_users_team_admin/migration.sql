-- Grant team_admin permission to all users in the "internal" project for all teams they belong to
INSERT INTO "TeamMemberDirectPermission" ("id", "tenancyId", "teamMemberId", "permissionDbId", "createdAt", "updatedAt")
SELECT 
    gen_random_uuid() AS "id",
    tm."tenancyId",
    tm."teamMemberId",
    p."dbId" AS "permissionDbId",
    CURRENT_TIMESTAMP AS "createdAt",
    CURRENT_TIMESTAMP AS "updatedAt"
FROM "TeamMember" tm
INNER JOIN "ProjectUser" pu ON tm."tenancyId" = pu."tenancyId" AND tm."projectUserId" = pu."projectUserId"
INNER JOIN "Project" proj ON pu."tenancyId" = proj."tenancyId" AND pu."projectId" = proj."id"
INNER JOIN "Permission" p ON p."projectConfigId" = proj."configId" AND p."id" = 'team_admin' AND p."scope" = 'TEAM'
WHERE proj."id" = 'internal'
    AND NOT EXISTS (
        -- Don't create duplicate permissions
        SELECT 1 
        FROM "TeamMemberDirectPermission" tmdp 
        WHERE tmdp."tenancyId" = tm."tenancyId" 
            AND tmdp."teamMemberId" = tm."teamMemberId" 
            AND tmdp."permissionDbId" = p."dbId"
    );