"use client"

import * as React from "react"
import {
  AtSignIcon, BoldIcon, CheckCircle2Icon, InboxIcon, InfoIcon, ItalicIcon, MailIcon,
  MoreHorizontalIcon, SearchIcon, ShieldAlertIcon, TriangleAlertIcon, UnderlineIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { Section, StateLabel, Subsection } from "../primitives"

const VARIANTS = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const
const HOVER: Record<(typeof VARIANTS)[number], string> = {
  default: "bg-[color-mix(in_oklch,var(--primary),var(--foreground)_28%)]!",
  secondary: "bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_14%)]!",
  outline: "border-ring! bg-accent! text-accent-foreground!",
  ghost: "bg-accent! text-accent-foreground!",
  destructive: "bg-destructive! text-destructive-foreground!",
  link: "underline!",
}
const FOCUS = "border-ring! ring-3! ring-ring/50!"

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <StateLabel>{label}</StateLabel>
      {children}
    </div>
  )
}

function Frame({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-lg border bg-card/50 p-4 sm:p-6 ${className}`}>{children}</div>
}

function ActionsBlock() {
  const [loading, setLoading] = React.useState(false)
  return (
    <>
      <Subsection title="Button" note="Variant by state. Hover and focus are pinned so they can be reviewed without interaction.">
        <Frame>
          <div className="overflow-x-auto">
            <div className="grid min-w-[40rem] grid-cols-[6rem_repeat(5,1fr)] items-center gap-x-4 gap-y-4">
              <span />
              {["default", "hover", "focus", "disabled", "loading"].map((s) => (
                <StateLabel key={s}>{s}</StateLabel>
              ))}
              {VARIANTS.map((v) => (
                <React.Fragment key={v}>
                  <StateLabel>{v}</StateLabel>
                  <div><Button variant={v}>Unlock</Button></div>
                  <div><Button variant={v} className={HOVER[v]}>Unlock</Button></div>
                  <div><Button variant={v} className={FOCUS}>Unlock</Button></div>
                  <div><Button variant={v} disabled>Unlock</Button></div>
                  <div>
                    <Button variant={v} disabled>
                      <Spinner data-icon="inline-start" />
                      Signing
                    </Button>
                  </div>
                </React.Fragment>
              ))}
            </div>
          </div>
        </Frame>
        <Frame className="flex flex-wrap items-end gap-6">
          <Cell label="xs"><Button size="xs">Copy</Button></Cell>
          <Cell label="sm"><Button size="sm">Copy</Button></Cell>
          <Cell label="default"><Button>Copy</Button></Cell>
          <Cell label="lg"><Button size="lg">Copy</Button></Cell>
          <Cell label="icon"><Button size="icon" variant="outline" aria-label="Mail"><MailIcon /></Button></Cell>
          <Cell label="icon-start">
            <Button><MailIcon data-icon="inline-start" />New agent</Button>
          </Cell>
          <Cell label="try loading">
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => {
                setLoading(true)
                setTimeout(() => setLoading(false), 1800)
              }}
            >
              {loading && <Spinner data-icon="inline-start" />}
              {loading ? "Resolving" : "Resolve name"}
            </Button>
          </Cell>
        </Frame>
      </Subsection>

      <Subsection title="Badge, Kbd and toggles">
        <Frame className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            {(["default", "secondary", "outline", "success", "warning", "info", "destructive", "ghost"] as const).map((v) => (
              <Badge key={v} variant={v}>{v}</Badge>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-6">
            <KbdGroup><Kbd>⌘</Kbd><Kbd>K</Kbd></KbdGroup>
            <ToggleGroup type="single" variant="outline" defaultValue="b" aria-label="Formatting">
              <ToggleGroupItem value="b" aria-label="Bold"><BoldIcon /></ToggleGroupItem>
              <ToggleGroupItem value="i" aria-label="Italic"><ItalicIcon /></ToggleGroupItem>
              <ToggleGroupItem value="u" aria-label="Underline"><UnderlineIcon /></ToggleGroupItem>
            </ToggleGroup>
            <Toggle variant="outline" defaultPressed>Muted</Toggle>
            <Toggle variant="outline" disabled>Disabled</Toggle>
          </div>
        </Frame>
      </Subsection>
    </>
  )
}

function InputsBlock() {
  return (
    <Subsection title="Fields" note="Typical, with description, invalid, disabled and required.">
      <Frame>
        <FieldGroup className="grid gap-6 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="sg-name">Agent name</FieldLabel>
            <Input id="sg-name" placeholder="alex" />
            <FieldDescription>Becomes alex.vikrant.nanitecom.eth.</FieldDescription>
          </Field>
          <Field data-invalid>
            <FieldLabel htmlFor="sg-bad">Recipient</FieldLabel>
            <Input id="sg-bad" aria-invalid defaultValue="alex@" />
            <FieldError>Enter a full address such as alex@nanite.email.</FieldError>
          </Field>
          <Field data-disabled>
            <FieldLabel htmlFor="sg-dis">Mailbox key</FieldLabel>
            <Input id="sg-dis" disabled defaultValue="locked until you sign" />
          </Field>
          <Field>
            <FieldLabel htmlFor="sg-req">Label (required)</FieldLabel>
            <Input id="sg-req" required placeholder="Shopping assistant" />
          </Field>
          <Field>
            <FieldLabel htmlFor="sg-ens">ENS name</FieldLabel>
            <InputGroup>
              <InputGroupAddon><AtSignIcon /></InputGroupAddon>
              <InputGroupInput id="sg-ens" defaultValue="alex" />
              <InputGroupAddon align="inline-end"><InputGroupText>.vikrant.nanitecom.eth</InputGroupText></InputGroupAddon>
            </InputGroup>
          </Field>
          <Field>
            <FieldLabel htmlFor="sg-ta">Agent context</FieldLabel>
            <Textarea id="sg-ta" rows={3} placeholder="What should this agent remember?" />
          </Field>
          <Field>
            <FieldLabel htmlFor="sg-sel">Send policy</FieldLabel>
            <Select defaultValue="reply-only">
              <SelectTrigger id="sg-sel" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">off</SelectItem>
                <SelectItem value="reply-only">reply-only</SelectItem>
                <SelectItem value="allowlist">allowlist</SelectItem>
                <SelectItem value="any">any</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Checkbox id="sg-c1" defaultChecked />
              <Label htmlFor="sg-c1">Notify on new mail</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="sg-sw" defaultChecked />
              <Label htmlFor="sg-sw">Agent can read mail</Label>
            </div>
            <RadioGroup defaultValue="otp" className="gap-2">
              <div className="flex items-center gap-2"><RadioGroupItem id="sg-r1" value="otp" /><Label htmlFor="sg-r1">Codes only</Label></div>
              <div className="flex items-center gap-2"><RadioGroupItem id="sg-r2" value="all" /><Label htmlFor="sg-r2">All mail</Label></div>
            </RadioGroup>
          </div>
        </FieldGroup>
      </Frame>
    </Subsection>
  )
}

function NavigationData() {
  return (
    <>
      <Subsection title="Navigation">
        <Frame className="flex flex-col gap-6">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem><BreadcrumbLink href="#components">Agents</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbLink href="#components">alex</BreadcrumbLink></BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbPage>Inbox</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <Tabs defaultValue="inbox">
            <TabsList>
              <TabsTrigger value="inbox">Inbox</TabsTrigger>
              <TabsTrigger value="sent">Sent</TabsTrigger>
              <TabsTrigger value="policy">Policy</TabsTrigger>
              <TabsTrigger value="off" disabled>Archive</TabsTrigger>
            </TabsList>
            <TabsContent value="inbox" className="text-sm text-muted-foreground">3 unread messages.</TabsContent>
            <TabsContent value="sent" className="text-sm text-muted-foreground">No mail sent yet.</TabsContent>
            <TabsContent value="policy" className="text-sm text-muted-foreground">Reply-only.</TabsContent>
          </Tabs>
        </Frame>
      </Subsection>

      <Subsection title="Data display">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Shopping assistant</CardTitle>
              <CardDescription>alex@nanite.email</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">Receives order confirmations and one-time codes.</CardContent>
            <CardFooter className="gap-2 border-t bg-muted/40 py-2">
              <Button size="sm">Open inbox</Button>
              <Button size="sm" variant="outline">Settings</Button>
            </CardFooter>
          </Card>
          <Frame className="p-0 sm:p-0">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Agent</TableHead><TableHead>Policy</TableHead><TableHead className="text-right">Unread</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                <TableRow><TableCell className="font-mono text-xs">alex</TableCell><TableCell><Badge variant="info">reply-only</Badge></TableCell><TableCell className="text-right tnum">3</TableCell></TableRow>
                <TableRow><TableCell className="font-mono text-xs">billing</TableCell><TableCell><Badge variant="success">allowlist</Badge></TableCell><TableCell className="text-right tnum">0</TableCell></TableRow>
                <TableRow><TableCell className="font-mono text-xs">scout</TableCell><TableCell><Badge variant="outline">off</Badge></TableCell><TableCell className="text-right tnum">12</TableCell></TableRow>
              </TableBody>
            </Table>
          </Frame>
          <Frame className="flex flex-wrap items-center gap-4">
            <Avatar size="sm"><AvatarFallback>A</AvatarFallback></Avatar>
            <Avatar><AvatarFallback>AL</AvatarFallback></Avatar>
            <Avatar size="lg"><AvatarFallback>AX</AvatarFallback></Avatar>
            <Separator orientation="vertical" className="h-8" />
            <span className="text-sm text-muted-foreground">Avatar, separator</span>
          </Frame>
          <ScrollArea className="h-32 rounded-lg border bg-card/50">
            <ul
              tabIndex={0}
              aria-label="Recent sender hashes"
              className="flex flex-col gap-1 p-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {Array.from({ length: 12 }, (_, i) => (
                <li key={i} className="text-muted-foreground tnum">0x{(0x9f3a + i * 977).toString(16)}…c21e</li>
              ))}
            </ul>
          </ScrollArea>
        </div>
      </Subsection>
    </>
  )
}

function FeedbackBlock() {
  return (
    <Subsection title="Feedback">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <Alert><InfoIcon /><AlertTitle>Mail is encrypted</AlertTitle><AlertDescription>Only your wallet can read it.</AlertDescription></Alert>
          <Alert variant="success"><CheckCircle2Icon /><AlertTitle>Name resolved</AlertTitle><AlertDescription>alex.vikrant.nanitecom.eth points to this mailbox.</AlertDescription></Alert>
          <Alert variant="warning"><TriangleAlertIcon /><AlertTitle>Send policy is any</AlertTitle><AlertDescription>This agent can email anyone. Switch to allowlist to limit it.</AlertDescription></Alert>
          <Alert variant="destructive"><ShieldAlertIcon /><AlertTitle>Access revoked</AlertTitle><AlertDescription>The agent record was cleared on ENS. Mail is no longer delivered.</AlertDescription></Alert>
        </div>
        <Frame className="flex flex-col gap-5">
          <Progress value={64} aria-label="Upload progress" />
          <div className="flex items-center gap-3"><Spinner /><span className="text-sm text-muted-foreground">Reading from Arkiv</span></div>
          <div className="flex flex-col gap-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-1/2" /></div>
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
              <EmptyTitle>No mail yet</EmptyTitle>
              <EmptyDescription>Give alex@nanite.email to a service to receive your first message.</EmptyDescription>
            </EmptyHeader>
          </Empty>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => toast.success("Copied alex@nanite.email")}>Success toast</Button>
            <Button variant="outline" size="sm" onClick={() => toast.error("Signature rejected")}>Error toast</Button>
          </div>
        </Frame>
      </div>
    </Subsection>
  )
}

// cmdk scrolls its first item into view on mount, which moves the whole page.
// Keeping it inside a dialog means it only mounts on demand.
function CommandDemo() {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="flex items-center gap-3">
      <Button variant="outline" onClick={() => setOpen(true)}>
        <SearchIcon data-icon="inline-start" />
        Command palette
        <KbdGroup><Kbd>⌘</Kbd><Kbd>K</Kbd></KbdGroup>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <Command>
          <CommandInput placeholder="Search agents" />
          <CommandList>
            <CommandEmpty>No agent found.</CommandEmpty>
            <CommandGroup heading="Agents">
              <CommandItem><SearchIcon />alex</CommandItem>
              <CommandItem><SearchIcon />billing</CommandItem>
              <CommandItem><SearchIcon />scout</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </div>
  )
}

function OverlaysBlock() {
  return (
    <Subsection title="Overlays">
      <Frame className="flex flex-wrap items-center gap-3">
        <Dialog>
          <DialogTrigger asChild><Button variant="outline">Dialog</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Revoke alex?</DialogTitle>
              <DialogDescription>The ENS record is cleared and new mail stops arriving. Existing mail stays readable.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline">Keep access</Button>
              <Button variant="destructive">Revoke</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Sheet>
          <SheetTrigger asChild><Button variant="outline">Sheet</Button></SheetTrigger>
          <SheetContent>
            <SheetHeader><SheetTitle>Agent settings</SheetTitle><SheetDescription>Edit records for alex.vikrant.nanitecom.eth.</SheetDescription></SheetHeader>
          </SheetContent>
        </Sheet>
        <Drawer>
          <DrawerTrigger asChild><Button variant="outline">Drawer</Button></DrawerTrigger>
          <DrawerContent>
            <DrawerHeader><DrawerTitle>Message actions</DrawerTitle><DrawerDescription>Swipe down to close.</DrawerDescription></DrawerHeader>
          </DrawerContent>
        </Drawer>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="More"><MoreHorizontalIcon /></Button></DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>alex</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Copy address</DropdownMenuItem>
            <DropdownMenuItem variant="destructive">Revoke</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover>
          <PopoverTrigger asChild><Button variant="outline">Popover</Button></PopoverTrigger>
          <PopoverContent>
            <PopoverHeader><PopoverTitle>Why encrypted?</PopoverTitle><PopoverDescription>Bodies are sealed to your key before storage.</PopoverDescription></PopoverHeader>
          </PopoverContent>
        </Popover>
        <Tooltip>
          <TooltipTrigger asChild><Button variant="outline">Tooltip</Button></TooltipTrigger>
          <TooltipContent>Reply-only agents can answer, not start threads</TooltipContent>
        </Tooltip>
      </Frame>
      <CommandDemo />
    </Subsection>
  )
}

export function ComponentsSection() {
  return (
    <Section
      id="components"
      index="07"
      title="Components"
      lead="shadcn primitives restyled through tokens: small radii, hairline borders, mono for state. Every variant, size and state a screen needs."
    >
      <ActionsBlock />
      <InputsBlock />
      <NavigationData />
      <FeedbackBlock />
      <OverlaysBlock />
    </Section>
  )
}
